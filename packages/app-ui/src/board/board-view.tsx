import type { LensKind } from "@rennet/protocol";
import { useState } from "react";
import { ProseSelectionLayer } from "../review";
import { useBoardData, useLensBoards } from "./board-data";
import { GenerationSwitcher } from "./generation-switcher";
import { BoardElementsProvider } from "./kinds/element-context";
import { LENS_LABEL, LensSwitcher } from "./lens-switcher";
import { Section } from "./section";

// ─────────────────────────────────────────────────────────────────────────────
// The lens board document (C05 6.1, Objective clause 6) — the review's reading
// heart. It assembles one lens board's sections in reading order under the board
// title, wrapped in C4's `ProseSelectionLayer` so a selection anywhere raises the
// Comment/Explain/Request-Changes toolbar (no duplicate toolbar logic — 6.2/5.2),
// and mounts the element pool through `BoardElementsProvider` so every citation
// resolves against the resolved board (never a walked prop tree).
//
// The switchers ride above the document: the lens switcher (a segment per PRESENT
// lens, absent-not-disabled) and, when there is more than one generation, the
// generation switcher (drill back to a frozen round). Both resolve through the one
// board-data seam — this component owns only the selected `(generation, lens)`.
//
// Fold-all (R44): every section starts folded EXCEPT on the Flagged lens, where the
// findings open on arrival. Delta sections are the exception to the exception — they
// open expanded regardless (section.tsx's own default), so passing `defaultOpen` only
// to force-open on Flagged and leaving it undefined elsewhere gives both behaviours.
// ─────────────────────────────────────────────────────────────────────────────

export interface LensBoardViewProps {
  /** The live generation to open on. */
  readonly generation: string;
  /** All generation ids for this review, oldest → newest (for drill-down). Defaults
   *  to just the live one, so the generation switcher stays hidden until there is a
   *  frozen predecessor to drill into. */
  readonly generations?: readonly string[];
}

export function LensBoardView({ generation, generations = [generation] }: LensBoardViewProps) {
  const [selectedGeneration, setSelectedGeneration] = useState(generation);
  const [pickedLens, setPickedLens] = useState<LensKind | null>(null);

  const lenses = useLensBoards(selectedGeneration);
  const present = lenses.map((l) => l.lens);

  // The effective lens: the reviewer's pick if it still has a board this generation,
  // else Flagged (R44's default reading order), else the first present lens. Derived,
  // not stored — drilling to a generation without the picked lens falls back cleanly.
  const effectiveLens: LensKind | null =
    pickedLens && present.includes(pickedLens)
      ? pickedLens
      : present.includes("flagged")
        ? "flagged"
        : (present[0] ?? null);

  // Flagged opens expanded (R44); every other lens folds all but its delta sections.
  const forceOpen = effectiveLens === "flagged" ? true : undefined;

  // Resolve the board to SHOW through the same seam, so an INVALID board renders as an
  // honest error rather than "no board yet" (finding 1). The display lens is the
  // effective (valid) lens; with none present, probe the reviewer's pick or the R44
  // default so a malformed board there still surfaces instead of vanishing.
  const displayLens: LensKind = effectiveLens ?? pickedLens ?? "flagged";
  const shown = useBoardData(selectedGeneration, displayLens);
  const board = shown.status === "valid" ? shown.board : undefined;

  return (
    <main data-kind="lens-board-view" className="mx-auto flex max-w-[820px] flex-col gap-4 p-6">
      <div className="flex flex-col gap-2">
        <GenerationSwitcher
          generations={generations}
          selected={selectedGeneration}
          current={generation}
          onSelect={setSelectedGeneration}
        />
        <LensSwitcher lenses={lenses} selected={effectiveLens} onSelect={setPickedLens} />
      </div>

      {board ? (
        <BoardElementsProvider
          elements={board.elements}
          generation={board.generation}
          boardId={board.boardId}
        >
          <ProseSelectionLayer>
            <article
              data-lens={board.lens}
              data-generation={board.generation}
              className="flex flex-col gap-1"
            >
              <h1 className="mb-2 font-display text-2xl text-foreground">
                {LENS_LABEL[board.lens]}
              </h1>
              {board.sections.map((entry) => (
                <Section key={entry.ref} entry={entry} defaultOpen={forceOpen} />
              ))}
            </article>
          </ProseSelectionLayer>
        </BoardElementsProvider>
      ) : shown.status === "invalid" ? (
        <div data-kind="board-error" data-reason={shown.reason} className="text-danger text-sm">
          <p className="font-medium">This board could not be read.</p>
          <p className="text-muted-foreground">
            {shown.reason === "identity"
              ? "The source returned a board for a different lens or generation."
              : shown.reason === "excluded-kind"
                ? "The board carries an element kind that no lens board renders."
                : "The board data did not match the expected shape."}
          </p>
        </div>
      ) : (
        <p data-kind="board-empty" className="text-muted-foreground text-sm">
          No board for this generation yet.
        </p>
      )}
    </main>
  );
}
