/**
 * `core/exits/` — the pure engine side of the three exits (B11). Cluster 1 lands
 * the durable-asks fold (`ask-projection`); the round work-order composition and
 * publish-compose sourcing land in later clusters over the same folder seam. No
 * I/O — the adapters persist the log and the server handlers are the sole writers.
 * This is the folder's import surface; the root `src/index.ts` re-exports it.
 */
export * from "./ask-projection";
export * from "./quote-carry";
