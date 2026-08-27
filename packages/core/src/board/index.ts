/**
 * `core/board/` — the pure board logic layer B08 builds over the B03-frozen
 * `protocol/src/board` seam and B04's runtime: lint (cluster 2), the validation
 * loop (cluster 3), and composition mechanics (cluster 4). No I/O, no model, no
 * Node — the direct analogue of B06's `core/knowledge/`. This is the folder's
 * import surface.
 */
export * from "./lint";
export * from "./validate";
