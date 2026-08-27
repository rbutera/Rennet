// core/delta — the patchset → drafter-input assembly (B5). This file is the
// folder's only import surface; siblings are implementation.

export * from "./blast-radius";
export * from "./counterpart-hints";
export * from "./element-diffs";
export { buildHunkIndex, type HunkIndex, type IndexedHunk } from "./hunk-index";
export * from "./noise-preclass";
export * from "./openspec-change";
