import type { Decomposition, OfferedManifest } from "@rennet/protocol";

/**
 * The deterministic offered manifest (#464 survivor, B2): the non-mechanical hunks
 * of a decomposition, each offered with its id / path / sides, for a model-facing
 * seat to anchor its output against. Extracted from the deleted `angle-generation`
 * pass — the pass (the model decomposition angle) died with the Board rebuild
 * (#489), but this deterministic producer is still read live by the flagged finding
 * review and the noise pre-classifier. No model in this path.
 */
export function buildOfferedManifest(decomposition: Decomposition): OfferedManifest {
  const mechanical = new Set(
    decomposition.classifications
      .filter((classification) => classification.kind === "mechanical")
      .map((classification) => classification.hunkId),
  );
  return {
    occurrences: decomposition.hunks
      .filter((hunk) => !mechanical.has(hunk.id))
      .map((hunk) => ({
        id: hunk.id,
        kind: "hunk",
        path: hunk.filePath,
        sides: {
          additions: hunk.addedLines,
          deletions: hunk.deletedLines,
          context: hunk.contextLines,
        },
      })),
  };
}
