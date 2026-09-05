/**
 * `board/` — the #462 host board schema and its draft derivation, authored on
 * `@wboard/core`'s host-schema kit. This is the folder's only public seam; the
 * root `src/index.ts` re-exports it.
 */
export * from "./kind-tables";
export * from "./lens-board";
export * from "./schema";
export * from "./tool-schemas";
