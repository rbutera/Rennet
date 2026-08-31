import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PARSED_FILE_CACHE_LIMIT, ParsedFileCache } from "./parsed-file-cache";

/**
 * The cache lives for the life of the daemon and is keyed by path, so an unbounded one retains
 * every file the process ever parsed — which is the leak, not the parse. What the bound has to
 * be is INVISIBLE: eviction may only cost a re-parse, never a wrong answer, and it must drop the
 * entry nobody has asked for rather than the one in use.
 *
 * Hit-validity (a rewritten file misses) is the property `stampOf` has always carried and is
 * exercised against the real stores in `store-read-caching.test.ts`; this file is about the bound.
 */
describe("ParsedFileCache", () => {
  const root = mkdtempSync(join(tmpdir(), "parsed-file-cache-"));
  const file = (name: string): string => {
    const path = join(root, name);
    writeFileSync(path, name);
    return path;
  };

  it("evicts the least recently USED entry past the bound, not the oldest inserted", () => {
    const cache = new ParsedFileCache<string>();
    const paths = Array.from({ length: PARSED_FILE_CACHE_LIMIT }, (_, i) => file(`entry-${i}`));
    for (const path of paths) cache.set(path, `v:${path}`);

    const first = paths[0] as string;
    const second = paths[1] as string;
    const newest = paths.at(-1) as string;

    // Read the oldest-inserted entry, then overflow by one. Insertion order would drop the entry
    // just read; recency drops the one after it.
    expect(cache.get(first)).toBe(`v:${first}`);
    cache.set(file("overflow"), "v:overflow");

    expect(cache.get(first)).toBe(`v:${first}`);
    expect(cache.get(second)).toBeUndefined();
    expect(cache.get(newest)).toBe(`v:${newest}`);
  });
});
