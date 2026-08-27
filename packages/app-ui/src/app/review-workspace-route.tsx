import type { Review } from "@rennet/protocol";

// STUB (B2, #489). The canvas-era review workspace surface — the diff heart, the
// Angles rail, the lens/canvas views — was deleted in the delete-first cutover. The
// Board rebuild (Track C) restores the review surface; until then this route stays
// registered and renders an honest placeholder so the app still launches into an
// open review. No behavior, no gate — the product is deliberately mid-rebuild.
export function ReviewWorkspace({ review }: { review: Review }) {
  return (
    <main
      className="review-workspace-stub grid min-h-screen place-content-center justify-items-center gap-2 bg-canvas p-8 text-center"
      role="status"
    >
      <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        REVIEW
      </p>
      <h1 className="m-0 font-display text-xl font-medium text-ink">
        The review surface is being rebuilt.
      </h1>
      <p className="m-0 max-w-[520px] leading-relaxed text-ink-soft">
        Rennet captured this review ({review.repositoryRoot.split("/").at(-1)}). The Board review
        surface lands with the ongoing rebuild.
      </p>
    </main>
  );
}
