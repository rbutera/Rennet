/**
 * Run `fn` over `items` with at most `concurrency` in flight at once, in
 * order-preserving batches, resolving when every item has run.
 *
 * The reason it exists (#19, "Refine all"): firing one model turn per item
 * unbounded spawns N concurrent `codex exec` / Claude subprocesses on a large
 * draft — real resource pressure (process count, memory, provider rate limits),
 * worse on a slow machine. Batching caps the fan-out WITHOUT the deferred
 * budget/ledger machinery; it is a feature-correctness bound, not a governance
 * gate. Pure and injectable (no React, no timers), so the cap is red-provable.
 */
export async function runBatched<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  for (let start = 0; start < items.length; start += limit) {
    await Promise.all(items.slice(start, start + limit).map((item) => fn(item)));
  }
}
