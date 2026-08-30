import type { BoardDocument, LensBoard, LensKind, SourceRef } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { useEffect } from "react";
import { useCoachAnchor } from "../coach/registry";
import { useRefreshCommand } from "../data";
import { ProseSelectionLayer, ReviewAnchoredAskProvider, RichText } from "../review";
import { lensBoardsFromResolutions, lensReadsSettled, useLensBoardResolutions } from "./board-data";
import { SourceChips } from "./design-meta";
import { DesignCapabilityGrid } from "./design-structure";
import { GenerationSwitcher } from "./generation-switcher";
import { BoardElementsProvider, useBoardPatchsetId } from "./kinds/element-context";
import { Section } from "./section";

// ─────────────────────────────────────────────────────────────────────────────
// The lens board document (C05 6.1, Objective clause 6) — the review's reading
// heart. It assembles one lens board's sections in reading order under the board
// title, wrapped in C4's `ProseSelectionLayer` so a selection anywhere raises the
// Comment/Explain/Request-Changes toolbar (no duplicate toolbar logic — 6.2/5.2),
// and mounts the element pool through `BoardElementsProvider` so every citation
// resolves against the resolved board (never a walked prop tree).
//
// The lens switcher lives in the session top bar. This document receives the URL-owned
// `(generation, lens)` selection and keeps only the generation drill-down beside the
// document it changes. There is no second local selection authority here.
//
// Fold-all (R44): every section starts folded EXCEPT on the Flagged lens, where the
// findings open on arrival. Delta sections are the exception to the exception — they
// open expanded regardless (section.tsx's own default), so passing `defaultOpen` only
// to force-open on Flagged and leaving it undefined elsewhere gives both behaviours.
// ─────────────────────────────────────────────────────────────────────────────

export interface LensBoardViewProps {
  /** The review whose boards are read — half of the `board.read` identity. */
  readonly reviewId: string;
  /** The live generation to open on. */
  readonly generation: string;
  /** The generation selected in the session URL. Absent means the live generation. */
  readonly selectedGeneration?: string;
  /** The lens selected in the session URL. */
  readonly lens: LensKind;
  /** All generation ids for this review, oldest → newest (for drill-down). Defaults
   *  to just the live one, so the generation switcher stays hidden until there is a
   *  frozen predecessor to drill into. */
  readonly generations?: readonly string[];
  /** Replace the session URL with a generation selection. */
  readonly onGenerationSelect?: (generation: string) => void;
}

export function LensBoardView({
  reviewId,
  generation,
  selectedGeneration = generation,
  lens,
  generations = [generation],
  onGenerationSelect = () => undefined,
}: LensBoardViewProps) {
  // The `highlight` coach mark anchors the prose document (centered on the region) — it
  // only registers once a board actually renders, so an empty/error board never elects it.
  const highlightRef = useCoachAnchor("highlight");

  const resolutions = useLensBoardResolutions(reviewId, selectedGeneration);
  const lenses = lensBoardsFromResolutions(resolutions);
  const available = lenses.map((l) => l.lens);

  // Drafting takes minutes and the daemon has no board-arrival push, so without this the
  // boards a capture just kicked would land on disk and the surface would keep saying "no
  // board for this generation yet" until the window happened to regain focus (the only other
  // thing that invalidates `board.read`). `useCommand` has no polling, so this is it.
  //
  // ponytail: a 5s poll while any lens is still missing, which means a review whose Noise
  // lens legitimately drafted nothing keeps polling for as long as the board is on screen —
  // five loopback reads every five seconds, no model spend. Upgrade path: a daemon-side
  // board-arrival channel (the `roundProgress` push already proves the transport), at which
  // point this whole effect goes.
  const refreshBoards = useRefreshCommand("board.read");
  const awaitingLenses = !lensReadsSettled(resolutions);
  useEffect(() => {
    if (!awaitingLenses) return;
    const timer = setInterval(refreshBoards, 5_000);
    return () => clearInterval(timer);
  }, [awaitingLenses, refreshBoards]);

  // A generation may not carry every lens. A genuinely missing selected lens falls back
  // to the first generated or failed lens in canonical order. Invalid and pending selected
  // boards stay selected so their honest state is surfaced rather than hidden behind another.
  const selected = resolutions[lens];
  const fallbackLens = available[0] ?? lens;
  const fallback = resolutions[fallbackLens];
  const effectiveLens: LensKind = selected.status === "missing" ? fallbackLens : lens;

  // Flagged opens expanded (R44); every other lens folds all but its delta sections.
  const forceOpen = effectiveLens === "flagged" ? true : undefined;

  // Resolve the board to SHOW through the same seam, so an INVALID board renders as an
  // honest error rather than "no board yet" (finding 1). The display lens is the
  // effective (valid) lens; with none present, probe the reviewer's pick or the R44
  // default so a malformed board there still surfaces instead of vanishing.
  const shown = effectiveLens === lens ? selected : fallback;
  const board = shown.status === "valid" ? shown.board : undefined;

  return (
    <main
      data-kind="lens-board-view"
      className={cn(
        "mx-auto flex w-full flex-col gap-6 p-6",
        board?.document.measure === "structured" ? "max-w-[960px]" : "max-w-[760px]",
      )}
    >
      <div className="flex flex-col gap-2">
        <GenerationSwitcher
          generations={generations}
          selected={selectedGeneration}
          current={generation}
          onSelect={onGenerationSelect}
        />
      </div>

      {board ? (
        <ReviewAnchoredAskProvider reviewId={reviewId}>
          <BoardElementsProvider
            elements={board.elements}
            reviewId={reviewId}
            generation={board.generation}
            boardId={board.boardId}
          >
            <ProseSelectionLayer>
              {/* Key the document subtree by boardId (finding 5): gen0/gen1 reuse section
                refs (change/design/tasks), so without a board-identity key switching
                generation would keep the prior board's per-section fold `useState`.
                Remounting on boardId resets fold state to the new board's foldAll. */}
              <article
                key={board.boardId}
                ref={highlightRef}
                data-lens={board.lens}
                data-generation={board.generation}
                className="flex flex-col"
              >
                <BoardHeader board={board} />
                {board.lens === "design" ? <DesignCapabilityGrid board={board} /> : null}
                <div className="flex flex-col gap-8">
                  {board.sections.map((entry) => (
                    <Section
                      key={entry.ref}
                      entry={entry}
                      lens={board.lens}
                      defaultOpen={forceOpen}
                    />
                  ))}
                </div>
              </article>
            </ProseSelectionLayer>
          </BoardElementsProvider>
        </ReviewAnchoredAskProvider>
      ) : shown.status === "invalid" ? (
        <div data-kind="board-error" data-reason={shown.reason} className="text-danger text-sm">
          <p className="font-medium">This board could not be read.</p>
          <p className="text-muted-foreground">
            {shown.reason === "identity"
              ? "The source returned a board for a different lens or generation."
              : shown.reason === "excluded-kind"
                ? "The board carries an element kind that no lens board renders."
                : shown.reason === "unreadable"
                  ? "The board read failed, so its contents are unknown."
                  : "The board data did not match the expected shape."}
          </p>
        </div>
      ) : shown.status === "pending" ? (
        <p data-kind="board-pending" className="text-muted-foreground text-sm">
          Reading this board…
        </p>
      ) : shown.status === "absent" ? (
        <div data-kind="board-absent" className="text-muted-foreground text-sm">
          <p className="font-medium text-foreground">
            {effectiveLens === "design"
              ? "No Design specification applies to this change."
              : "No source material was found."}
          </p>
          <p>
            {effectiveLens === "design"
              ? "There is no applicable specification to project into a Design board for this generation."
              : "This generation has no material to project into the selected board."}
          </p>
        </div>
      ) : shown.status === "failed" ? (
        <div data-kind="board-failed" role="alert" className="text-danger text-sm">
          <p className="font-medium">This lens failed to generate.</p>
          <p className="text-muted-foreground">{shown.reason}</p>
        </div>
      ) : (
        <p data-kind="board-empty" className="text-muted-foreground text-sm">
          No board for this generation yet.
        </p>
      )}
    </main>
  );
}

function sourceTarget(board: LensBoard, source: SourceRef): string | undefined {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  return board.sections.find(({ ref }) => {
    const section = byId.get(ref);
    if (section?.kind !== "section") return false;
    return (section.data.sources ?? []).some(
      (candidate) => candidate.path === source.path && candidate.candidate === source.candidate,
    );
  })?.ref;
}

function BoardHeader({ board }: { readonly board: LensBoard }) {
  const document: BoardDocument = board.document;
  return (
    <header className="mb-8 flex flex-col gap-4">
      <h1 className="font-display text-2xl text-foreground tracking-tight">{document.title}</h1>
      {document.stats && document.stats.length > 0 ? (
        <dl data-kind="board-stats" className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {document.stats.map((stat) => (
            <div
              key={stat.label}
              data-kind={
                board.lens === "design" && stat.label.toLowerCase() === "format"
                  ? "design-format"
                  : "board-stat"
              }
              className={cn(
                "flex items-baseline gap-1.5",
                board.lens === "design" &&
                  stat.label.toLowerCase() === "format" &&
                  "rounded-chip border border-line bg-raised px-2 py-1",
              )}
            >
              <dt className="text-2xs text-muted-foreground">{stat.label}</dt>
              <dd
                className={cn(
                  "font-medium text-sm text-foreground",
                  board.lens === "design" && stat.label.toLowerCase() === "format" && "font-mono",
                )}
              >
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {document.introMarkdown.length > 0 ? <BoardIntro markdown={document.introMarkdown} /> : null}
      <SourceChips
        sources={document.sources ?? []}
        kind="artifact"
        {...(board.lens === "design"
          ? { targetForSource: (source: SourceRef) => sourceTarget(board, source) }
          : {})}
      />
    </header>
  );
}

function BoardIntro({ markdown }: { readonly markdown: string }) {
  const patchsetId = useBoardPatchsetId();
  return (
    <RichText
      text={markdown}
      patchsetId={patchsetId}
      className="max-w-[640px]"
      paragraphClassName="text-base leading-relaxed text-foreground/85"
    />
  );
}
