import { Button, cn } from "@rennet/ui";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useCommand, useMutation } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// THE PREPARATION PRESENCE (review-preparation-reliability D6, task 3.1) — the board area
// while a review is on its way and no seat has opened yet.
//
// Rai, on the build this replaces: the PR opened and "it didn't look like it was working
// at all (normally the lenses all populate)". The board said "No board for this generation
// yet." over an empty column, which is an internal state read aloud. Now the board area is
// a skeleton of a board with a slow sweep, and the rail above breathes in step with it
// (`lens-switcher.tsx`, `waiting`): one presence, saying "your review is coming".
//
// What it does NOT do, and why: it names no step ("step names unnecessary") and it draws no
// seat. Before any lane opens there is no seat, and five invented readers would be the lie
// `lens-seats.ts` exists to prevent. The skeleton is the shape of a board, not of a lens.
//
// Cancel is inline, under the skeleton, because this is the one thing the reviewer can do
// to a review that has not started drafting. Once a lane moves the presence steps aside
// and Cancel moves to the floating chip over the real boards.
//
// Reduced motion: the sweep removes itself (`motion-reduce:hidden`) and the skeleton
// stands still. It still reads as a board being laid out, not as an empty page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the presence is on screen in this workspace, so the header knows if a running
 * preparation already has its Cancel. The presence renders only where there is no board to
 * show — on the board view, before any board exists — so a waiting run viewed on the diff,
 * or over boards an earlier attempt drafted, has no inline Cancel and the header floats one
 * instead. One Cancel, always: never none, never two.
 */
const PresenceShown = createContext<{
  readonly shown: boolean;
  readonly setShown: (shown: boolean) => void;
} | null>(null);

export function PresenceScope({ children }: { readonly children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return <PresenceShown.Provider value={{ shown, setShown }}>{children}</PresenceShown.Provider>;
}

/** True while a `PreparationPresence` — and so its inline Cancel — is mounted in scope. */
export function usePresenceShown(): boolean {
  return useContext(PresenceShown)?.shown ?? false;
}

/** The skeleton's section cards, as widths of their two lines. Fixed rather than random so
 *  the frame is identical on every render and in every screenshot. */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["w-3/4", "w-1/2"],
  ["w-2/3", "w-2/5"],
  ["w-4/5", "w-1/3"],
  ["w-3/5", "w-1/2"],
];

/** The sweep one card carries. The same curve and length on every card, offset a little per
 *  card, so the band reads as one wave travelling down the board. */
function Sweep({ index }: { readonly index: number }) {
  return (
    <span
      aria-hidden="true"
      data-motion="sweep"
      className="pointer-events-none absolute inset-y-0 left-0 w-1/2 animate-presence-sweep bg-gradient-to-r from-transparent via-ink/6 to-transparent motion-reduce:hidden"
      style={{ animationDelay: `${index * 140}ms` }}
    />
  );
}

function Bar({ className }: { readonly className: string }) {
  return <span className={cn("block rounded-full bg-line/70", className)} />;
}

export function PreparationPresence({
  slug,
  className,
}: {
  /** The session being prepared — what Cancel stops. */
  readonly slug: string;
  readonly className?: string;
}) {
  const { data } = useCommand("session.list", {}, { enabled: slug.length > 0 });
  const session = data?.sessions.find((candidate) => candidate.id === slug);
  const cancel = useMutation("session.cancelPreparation", { invalidates: ["session.list"] });
  const setShown = useContext(PresenceShown)?.setShown;
  useEffect(() => {
    setShown?.(true);
    return () => setShown?.(false);
  }, [setShown]);

  return (
    <section
      data-kind="preparation-presence"
      aria-busy="true"
      className={cn("mx-auto flex w-full max-w-[760px] flex-col gap-8 px-8 py-8", className)}
    >
      {/* One sentence for a screen reader, because the motion is invisible to it. It says
          that the review is coming, never which step it is on. */}
      <p role="status" className="sr-only">
        Preparing this review.
      </p>
      <div data-slot="board-skeleton" aria-hidden="true" className="flex flex-col gap-6">
        <div className="relative flex flex-col gap-3 overflow-hidden rounded-xl py-1">
          <Bar className="h-5 w-2/5" />
          <Bar className="h-3 w-1/4" />
          <Sweep index={0} />
        </div>
        {SECTIONS.map(([first, second], index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative rows with no identity beyond their position.
            key={index}
            className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-line/60 bg-surface/40 p-4"
          >
            <Bar className={cn("h-3.5", first)} />
            <Bar className={cn("h-3", second)} />
            <Sweep index={index + 1} />
          </div>
        ))}
      </div>
      {session ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            data-testid="preparation-cancel"
            disabled={cancel.pending}
            onClick={() => void cancel.mutate({ sessionId: session.id })}
            className="app-region-no-drag text-ink-soft"
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </section>
  );
}
