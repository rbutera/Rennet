// The token cache is the answer to perf-audit §5 H6: before it, a diff surface
// re-ran the TextMate grammar over every painted row on every render, so scrolling
// re-tokenized the viewport per frame. These tests count the misses — the lines that
// actually reached Shiki — because "it is cached" is only true if the tokenizer stops
// being called.
import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN_CACHE_LIMIT, tokenCacheProbe, tokenizeLine } from "./shiki";

beforeEach(() => tokenCacheProbe.reset());

describe("shiki token cache", () => {
  it("tokenizes a repeated (text, language) exactly once", () => {
    const line = "const value = compute(1, 2);";
    const first = tokenizeLine(line, "typescript");
    expect(tokenCacheProbe.misses).toBe(1);

    for (let repeat = 0; repeat < 50; repeat += 1) tokenizeLine(line, "typescript");
    expect(tokenCacheProbe.misses).toBe(1);
    expect(tokenCacheProbe.hits).toBe(50);
    // Same tokens, not merely the same count.
    expect(tokenizeLine(line, "typescript")).toEqual(first);

    // Positive control: the miss counter is live and the key really carries the
    // language — the same text under a different grammar is a different entry.
    tokenizeLine(line, "javascript");
    expect(tokenCacheProbe.misses).toBe(2);
  });

  it("stays at its cap and evicts the least-recently-used line", () => {
    const line = (n: number) => `const v${n} = ${n};`;
    for (let index = 0; index <= TOKEN_CACHE_LIMIT; index += 1) {
      tokenizeLine(line(index), "typescript");
    }
    expect(tokenCacheProbe.misses).toBe(TOKEN_CACHE_LIMIT + 1);
    expect(tokenCacheProbe.size()).toBe(TOKEN_CACHE_LIMIT);

    // The oldest line was pushed out, so asking for it again reaches Shiki.
    const missesBefore = tokenCacheProbe.misses;
    tokenizeLine(line(0), "typescript");
    expect(tokenCacheProbe.misses).toBe(missesBefore + 1);

    // Positive control, and the one that makes the assertion above mean "evicted"
    // rather than "never stored anything": the newest line is still resident.
    const hitsBefore = tokenCacheProbe.hits;
    tokenizeLine(line(TOKEN_CACHE_LIMIT), "typescript");
    expect(tokenCacheProbe.hits).toBe(hitsBefore + 1);
  });

  it("keeps a re-read line alive: a hit refreshes its recency", () => {
    const line = (n: number) => `const w${n} = ${n};`;
    for (let index = 0; index < TOKEN_CACHE_LIMIT; index += 1) {
      tokenizeLine(line(index), "typescript");
    }
    // Touch the oldest entry, then overflow by one. Plain insertion order would
    // evict entry 0; LRU evicts entry 1 instead.
    tokenizeLine(line(0), "typescript");
    tokenizeLine("const fresh = 1;", "typescript");

    const missesBefore = tokenCacheProbe.misses;
    tokenizeLine(line(0), "typescript");
    expect(tokenCacheProbe.misses).toBe(missesBefore);
    // Positive control: something WAS evicted by that overflow — the entry the
    // refresh demoted to oldest.
    tokenizeLine(line(1), "typescript");
    expect(tokenCacheProbe.misses).toBe(missesBefore + 1);
  });
});
