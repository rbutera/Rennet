import type { LensBoard, LensKind } from "@rennet/protocol";
import { decisionsBoard } from "./decisions";
import { designBoard, designGen0Board } from "./design";
import { flaggedBoard, flaggedGen2Board } from "./flagged";
import { noiseBoard } from "./noise";
import { sequenceBoard, sequenceGen2Board } from "./sequence";

export { decisionsBoard } from "./decisions";
export { designBoard, designGen0Board } from "./design";
export { flaggedBoard, flaggedGen2Board } from "./flagged";
export * from "./helpers";
export { noiseBoard } from "./noise";
export { sequenceBoard, sequenceGen2Board } from "./sequence";

/**
 * The fixture board set, keyed by generation then lens — the append-then-freeze
 * generations of one review. `gen0` is the propose-time frozen Design board (the
 * drill-down target); `gen1` is the implemented round; `gen2` is after round 1
 * (Sequence gains an addressed chapter, Flagged carries deltas). A lens absent from
 * a generation has NO board that generation (absent-not-disabled, the lens switcher's
 * contract), which is why the map is partial.
 */
export const FIXTURE_BOARDS: Readonly<Record<string, Partial<Record<LensKind, LensBoard>>>> = {
  gen0: { design: designGen0Board },
  gen1: {
    design: designBoard,
    decisions: decisionsBoard,
    sequence: sequenceBoard,
    flagged: flaggedBoard,
    noise: noiseBoard,
  },
  gen2: { sequence: sequenceGen2Board, flagged: flaggedGen2Board },
};

/**
 * A {@link BoardSource} over the fixture set: resolve `(generation, lens)` to its
 * board, or `undefined` when that lens has no board this generation. Handed to
 * `BoardSourceProvider` in tests — the surface never imports this directory (the
 * import fence). Structurally the `BoardSource` board-data declares.
 */
export const fixtureBoardSource = (generation: string, lens: LensKind): LensBoard | undefined =>
  FIXTURE_BOARDS[generation]?.[lens];
