import { cn } from "@rennet/ui";
import { Suspense } from "react";
import { useT3ChatSlot } from "../chat/t3-chat-slot";
import { useCommand } from "../data/query";
import { useOpenCapturedPath } from "../review/code-destination";
import { useRennetStore } from "../store";
import { LENS_LABEL } from "./lens-seats";

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT TRANSCRIPT DRAWER (lens-board-tools 6.2, D14) — the SECOND mount of the
// T3 thread view, and the reason there had to be one.
//
// `t3-chat-dock.tsx` used to be the only mount, which is exactly why the bench opened a
// seat's transcript by RETARGETING the dock: there was nowhere else to put it. That took
// the reviewer's own conversation away from them every time they looked at a seat (#823,
// "a big nono"). So the transcript opens here instead: right-aligned INSIDE the board
// region, read-only, streaming, and the dock keeps the session's thread throughout.
//
// The drawer and the diff view share ONE slot (D14): the diff is a `?view` and this is
// store state, so the two are reconciled by the workspace — opening the diff clears this
// ref and opening this navigates back to the board. Below the shell's minimum surface
// width the drawer takes the whole board region rather than squeezing the board into a
// column too narrow to read; it still never touches the dock, which is outside the outlet.
//
// A right-aligned drawer over the wireframe's push-down variant is a CHOICE and D14
// records it: the board and its receipts are read together (the wireframe's own tie
// letters pair an element with the receipt that made it), and a push-down puts them one
// scroll apart.
// ─────────────────────────────────────────────────────────────────────────────

export function SeatTranscriptDrawer({ reviewId }: { readonly reviewId: string }) {
  const open = useRennetStore((s) => s.ui.seatTranscript);
  const openSeatTranscript = useRennetStore((s) => s.uiActions.openSeatTranscript);
  const slot = useT3ChatSlot();
  const openFileInDiff = useOpenCapturedPath();
  // The sidecar session for THIS review — the same read the dock runs, so the two share
  // one cache key and one fetch rather than starting a second sidecar conversation.
  const { data, error, pending } = useCommand(
    "chat.t3Session",
    reviewId.length === 0 ? {} : { reviewId },
    { enabled: reviewId.length > 0 },
  );
  // The store slice is global and this drawer is mounted once per workspace, so a ref
  // belonging to ANOTHER review is not this drawer's. Treated as none in the same render
  // rather than through an effect, which would paint one frame of the previous session's
  // transcript inside this session's board.
  if (open === null || open.reviewId !== reviewId) return null;

  return (
    <aside
      data-kind="seat-transcript-drawer"
      data-lens={open.lens}
      data-seat={open.seat}
      aria-label={`${LENS_LABEL[open.lens]} seat transcript`}
      className={cn(
        // FULL WIDTH when the board region is narrow, a 380px right-aligned column when it
        // is not. The threshold is a container query on the BOARD REGION at 54rem — not
        // the viewport, so a wide window with a wide chat dock still gets the narrow
        // treatment, which is the case that matters.
        //
        // D14 says "below the shell's `MIN_SURFACE_WIDTH`", and that is NOT what ships:
        // that constant is 400px of viewport and this is 54rem of container, which is the
        // measure that actually decides whether two columns fit here. Written down rather
        // than quietly diverged from. The two numbers live in the class because Tailwind
        // reads source text — a width built from an exported constant generates no CSS,
        // which is why there is no constant to export.
        "flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-line border-l bg-surface",
        "@[54rem]:w-[380px]",
      )}
    >
      <header className="flex flex-none items-center gap-2 border-line border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-ink-soft text-xs">
          {LENS_LABEL[open.lens]} seat · live · read-only
        </span>
        <button
          type="button"
          data-testid="seat-transcript-close"
          onClick={() => openSeatTranscript(null)}
          className="rounded-control px-2 py-0.5 text-ink-soft text-xs hover:bg-raised hover:text-ink"
        >
          Close
        </button>
      </header>
      {error ? (
        <p data-slot="seat-transcript-error" className="p-3 text-ink-soft text-xs">
          T3 Code sidecar unavailable: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : pending || !data ? (
        <p data-slot="seat-transcript-starting" className="p-3 text-ink-soft text-xs">
          Starting the T3 Code sidecar…
        </p>
      ) : slot ? (
        <Suspense
          fallback={
            <p data-slot="seat-transcript-starting" className="p-3 text-ink-soft text-xs">
              Loading the thread view…
            </p>
          }
        >
          <slot.thread session={data} thread={open.thread} readOnly onOpenFile={openFileInDiff} />
        </Suspense>
      ) : (
        <p data-slot="seat-transcript-unmounted" className="p-3 text-ink-soft text-xs">
          This host does not mount the thread view.
        </p>
      )}
    </aside>
  );
}
