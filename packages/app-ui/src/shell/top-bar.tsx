import { currentGenerationId, type LensKind } from "@rennet/protocol";
import { cn, Toggle, ToggleGroup } from "@rennet/ui";
import { ArrowLeft, FileDiff, History, type LucideIcon, MessageCircle } from "lucide-react";
import { Fragment, useEffect } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { LensSwitcher } from "../board";
import { lensesWithResult, useBoardData, useLensBoards } from "../board/board-data";
import { countOpenFindings } from "../board/finding-lifecycle";
import { useLensActivityHistory } from "../board/lens-activity-state";
import { seatHoldsSelection } from "../board/lens-seats";
import { Icon } from "../components/icon";
import { useRoundRecords, useRoundState, useRoundsUnavailable } from "../rounds/rounds-data";
import { useSlugResolution } from "../routes/slug";
import {
  DEFAULT_VIEW,
  ROUTES,
  readSessionQuery,
  sessionPath,
  type ViewKind,
  viewToggle,
} from "../routes/url";
import { useRennetStore } from "../store";
import { cornerSlotOwner, useMacTrafficLights } from "./corner-slot";
import { useSidebarTree } from "./sidebar-data";
import { Trail, type TrailProps } from "./trail";

// ─────────────────────────────────────────────────────────────────────────────
// The 56px session top-bar (C03 §4, R51). The frame renders it on session routes
// only (the 40px takeover tier belongs to each takeover surface — reconciliation
// 6). A three-column grid: LEFT slot (back arrow exactly when `?view` is not the
// board; then the app's ONE chat open/close toggle; then the two-line trail —
// only while the chat dock is SHUT, since the open dock's header carries it), a
// CENTERED lens-switcher slot C5 fills, and the RIGHT slot's History · Diff
// pills — a C2 `ToggleGroup` over `?view`, selection DERIVED from the URL, toggling
// navigating with `viewToggle` (replace).
//
// The PILL LOOK is a skin, not a different control. The prototype draws outlined
// chrome pills (History alone on its own round outline, Map and Diff sharing one
// outline split by a hairline), so the tray opts out of its own well with
// `border-transparent bg-transparent p-0` and each member takes the round shape.
// Everything the kit owns stays owned: one `role="group"` labelled "Session view",
// arrow-key roving focus across all three members, `aria-pressed` per member, and
// the empty-selection state Base UI models natively as `value={[]}` — which is what
// the board is, with none of the three pressed. Hand-rolling the buttons to get the
// skin also dodged the segmented-control lint; the skin was never the reason to.
//
// C20: the chat toggle lives on the RIGHTMOST pane, not in the chat header, and it
// is present in BOTH directions — one control that opens and closes, never a split
// expand-here / collapse-there pair. A control that only appears when the chat is
// shut is a control you cannot find while the chat is open.
//
// C20 state 3 — sidebar collapsed AND chat closed — the bar DISSOLVES: the main view
// goes full-bleed and this header becomes an absolutely-positioned, pointer-events-none
// overlay whose three slots become translucent blurred chips (the one sanctioned use of
// translucent chrome, DESIGN.md §Material amended 2026-08-28). It dissolves the bar's
// CHROME, never its data: every control the bar shows in states 1–2 still renders here,
// restyled. Dropping a chip because it "does not fit the floating layer" would be a lie
// by omission. The left chip group clears the floating corner slot horizontally.
// ─────────────────────────────────────────────────────────────────────────────

/** The pill's three explicit views, in order, with their labels and glyphs. */
const PILL: ReadonlyArray<{
  readonly view: Extract<ViewKind, "rounds" | "diff">;
  readonly label: string;
  readonly icon: LucideIcon;
  /**
   * The container width below which the label folds away, leaving the glyph — one
   * threshold per state of the left slot. With the chat dock OPEN the trail is in the
   * dock's header and the left slot is a single 24px toggle, so the bar has ~12rem more
   * room than it has with the dock shut, and folding Diff at the shut-dock width hid the
   * label on a bar with plenty of space (Rai, 2026-09-08: "diff should also have the
   * label when it's clearly got enough room"). The numbers are the measured sum of the
   * five-lens rail (~33rem), the pills with both labels (~10rem), the paddings, and the
   * left slot in each state (1.5rem open; ~14rem shut), each variant a literal so
   * Tailwind can read it.
   */
  readonly foldBelow: { readonly chatOpen: string; readonly chatShut: string };
}> = [
  // History folds EARLIER than Diff: it sits nearest the centred lens pill,
  // and the two look cramped the moment they touch.
  {
    view: "rounds",
    label: "History",
    icon: History,
    foldBelow: { chatOpen: "hidden @[48rem]:inline", chatShut: "hidden @[61rem]:inline" },
  },
  {
    view: "diff",
    label: "Diff",
    icon: FileDiff,
    foldBelow: { chatOpen: "hidden @[44rem]:inline", chatShut: "hidden @[57rem]:inline" },
  },
];

/** One kit `Toggle` wearing the prototype pill skin: round, outlined, 12px label.
 *  No `aria-label` — the visible label IS the name, and the `title` covers the
 *  folded width where the label is `display:none` and out of the name computation.
 *  Repeating it as an `aria-label` only makes the control announce twice. */
function PillToggle({
  entry,
  chatOpen,
  className,
}: {
  readonly entry: (typeof PILL)[number];
  readonly chatOpen: boolean;
  readonly className?: string;
}) {
  return (
    <Toggle
      value={entry.view}
      title={entry.label}
      className={cn(
        "h-auto min-w-0 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground data-pressed:bg-secondary",
        className,
      )}
    >
      <Icon icon={entry.icon} className="size-3.5 shrink-0" />
      <span className={chatOpen ? entry.foldBelow.chatOpen : entry.foldBelow.chatShut}>
        {entry.label}
      </span>
    </Toggle>
  );
}

export function TopBar() {
  const [, navigate] = useLocation();
  const [, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const search = useSearch();
  const chatOpen = useRennetStore((s) => s.ui.chatOpen);
  const setChatOpen = useRennetStore((s) => s.uiActions.setChatOpen);
  const { hosts } = useSidebarTree();
  const mac = useMacTrafficLights();
  // State 3: nothing is left to the main view's left, so the bar dissolves into chips.
  // `TopBar` renders on session routes only, so the dock is open exactly when the chat is.
  const sidebarOpen = useRennetStore((s) => s.ui.sidebarOpen);
  const floating = cornerSlotOwner({ sidebarOpen, dockOpen: chatOpen }) === "floating";

  const slug = sessionParams?.slug
    ? decodeURIComponent(sessionParams.slug)
    : runParams?.slug
      ? decodeURIComponent(runParams.slug)
      : "";
  const searchParams = new URLSearchParams(search);
  const routeQuery = readSessionQuery(searchParams);
  const resolution = useSlugResolution(slug);
  const roundState = useRoundState(slug);
  const roundRecords = useRoundRecords(slug);
  const review = resolution.status === "review" ? resolution.review : undefined;
  const liveGeneration = review
    ? roundState.phase === "composed"
      ? roundState.newGeneration
      : currentGenerationId(roundRecords, review.activePatchsetId)
    : "";
  const selectedGeneration = routeQuery.generation ?? liveGeneration;
  // The rail lists all five lenses from the first frame, each carrying its seat state
  // (5.1/D12) — which is why it takes the SLUG: the lanes are read off the session row,
  // and during capture there is no review to read a board from at all.
  const lenses = useLensBoards(slug, review?.id ?? "", selectedGeneration);
  const observeActivity = useLensActivityHistory((state) => state.observe);
  useEffect(
    () => observeActivity(review?.id ?? slug, selectedGeneration, lenses),
    [observeActivity, review?.id, slug, selectedGeneration, lenses],
  );
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const findingDispositions = useRennetStore((s) => s.review.findingDispositions);
  const flaggedBoard = lenses.find(({ lens }) => lens === "flagged")?.board;
  const flaggedOpenCount = flaggedBoard
    ? countOpenFindings(flaggedBoard, { stagedAsks, findingDispositions })
    : 0;
  const selectedBoard = useBoardData(review?.id ?? "", selectedGeneration, routeQuery.lens);
  // The fallback is a lens with something to OPEN, not the first rail entry: the rail
  // now always starts at Design, and falling back to it would open an empty board over
  // a settled sibling.
  // …and never while the requested lens's seat is live (`seatHoldsSelection`): a running
  // lane's board is arriving, so the tab the reviewer clicked stays the tab that is lit.
  const fallbackLens = lensesWithResult(lenses)[0]?.lens;
  const requestedSeat = lenses.find(({ lens }) => lens === routeQuery.lens)?.seat;
  const effectiveLens =
    selectedBoard.status === "missing" &&
    fallbackLens !== undefined &&
    (requestedSeat === undefined || !seatHoldsSelection(requestedSeat))
      ? fallbackLens
      : routeQuery.lens;
  const query = routeQuery;
  const canonicalFrozenFallback =
    query.generation !== null &&
    selectedGeneration !== liveGeneration &&
    effectiveLens !== query.lens;
  const current = {
    lens: canonicalFrozenFallback ? effectiveLens : query.lens,
    generation: query.generation ?? undefined,
    file: query.file ?? undefined,
    round: query.round ?? undefined,
    ask: query.ask ?? undefined,
  };

  // A completed frozen generation may not contain the lens named by the prior URL. Missing
  // is the one state that permits a fallback: malformed or unreadable boards stay selected.
  // Live generations draft progressively, so their temporary missing answers never rewrite
  // the request. Replace only a frozen stale address, and never interrupt `/run`.
  useEffect(() => {
    if (sessionParams?.slug === undefined || !canonicalFrozenFallback) return;
    navigate(
      sessionPath(slug, {
        view: routeQuery.view,
        lens: effectiveLens,
        generation: routeQuery.generation ?? undefined,
        file: routeQuery.file ?? undefined,
        round: routeQuery.round ?? undefined,
        ask: routeQuery.ask ?? undefined,
      }),
      { replace: true },
    );
  }, [
    canonicalFrozenFallback,
    effectiveLens,
    navigate,
    routeQuery.ask,
    routeQuery.file,
    routeQuery.generation,
    routeQuery.round,
    routeQuery.view,
    sessionParams?.slug,
    slug,
  ]);
  const offBoard = query.view !== DEFAULT_VIEW;
  // The History (rounds) toggle is present EXACTLY when a round has completed (C09 §6.2) —
  // the derived-presence url.ts gates `?view=rounds` on, never a disabled tab. With no
  // completed round it drops from the pill entirely (honest-absent by default, since no
  // rounds runtime is bound yet — Reconciliation 1). Diff is always present.
  // …and ALSO present when the rounds cannot be read at all (review finding 9): dropping the
  // toggle then would hide the disclosure behind an absence that reads as "no rounds", and
  // the reviewer would have no way to reach the reason. Presence still tracks the truth —
  // it is just that "unknown" is a different truth from "none".
  const roundsUnavailable = useRoundsUnavailable(slug);
  const historyEntry =
    roundRecords.length > 0 || roundsUnavailable !== undefined
      ? PILL.find((p) => p.view === "rounds")
      : undefined;
  const mapDiff = PILL.filter((p) => p.view !== "rounds");
  // A pill is selected only for its three explicit views; the board and handoff
  // select none (value = []), never the "" sentinel (S6).
  const pillValue = PILL.some((p) => p.view === query.view) ? [query.view] : [];

  // Resolve the trail from the active session row; a slug in no row falls back to the
  // slug alone rather than inventing a project or a target.
  const activeSession = hosts
    .flatMap((h) => h.projects)
    .flatMap((project) => project.sessions.map((session) => ({ session, project })))
    .find((row) => row.session.slug === slug);
  const trail: TrailProps = activeSession
    ? {
        title: activeSession.session.title,
        projectName: activeSession.project.name,
        target: activeSession.session.target,
        targetState: activeSession.session.targetState,
      }
    : { title: slug };

  function toBoard() {
    const { path, replace } = viewToggle(slug, "board", current);
    navigate(path, { replace });
  }

  function onPill(next: string[]) {
    const view = (next[0] as ViewKind | undefined) ?? DEFAULT_VIEW;
    const { path, replace } = viewToggle(slug, view, current);
    navigate(path, { replace });
  }

  function onLens(lens: LensKind) {
    navigate(sessionPath(slug, { ...current, view: "board", lens }), { replace: true });
  }

  // The chip skin. Rai's 2026-08-28 amendment sanctions TRANSLUCENCY AND BLUR for chrome
  // floating over content — and nothing else. DESIGN.md's separate ban on decorative
  // shadows was not amended, so the chips carry a hairline, not a shadow.
  const chip = "border border-line/60 bg-surface/70 backdrop-blur-md";
  const iconButton = floating
    ? cn("app-region-no-drag size-8 rounded-full", chip)
    : "app-region-no-drag size-6 rounded-md hover:bg-secondary";
  return (
    <header
      data-slot="session-top-bar"
      data-floating={floating}
      className={cn(
        // THREE COLUMNS, the middle sized to the rail and the sides sharing what is left,
        // so the rail sits on the bar's centre line whenever both sides fit (a side that
        // needs more takes it, and the rail shifts only then). Below 640px the rail drops
        // to a second row across both columns. Vertical padding is 4px: the solid bar
        // is exactly the dock header's 56px (`chat/chat-header.tsx`, `h-14`), so the two
        // title bars meet at one rule across the window.
        "grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-0 px-3 py-1 @container @max-[640px]:grid-cols-[1fr_auto]",
        floating
          ? "pointer-events-none absolute inset-x-0 top-0 z-30 min-h-11"
          : "min-h-14 shrink-0 border-b border-line",
        // In the SOLID bar (states 1–2), the empty space and the trail text drag
        // the window on darwin — the same titlebar affordance the corner slot carries.
        // Every control inside marks itself `app-region-no-drag` (below) or it goes dead.
        // The floating bar is `pointer-events-none` and dissolves into interactive chips,
        // so it never claims the drag region — dragging over full-bleed content is not it.
        !floating && mac && "app-region-drag",
      )}
    >
      {/* LEFT slot: back arrow (off-board), the one chat toggle, trail. In state 3 it
        starts clear of the floating corner slot — which on darwin reserves the real
        traffic lights, and elsewhere is just the pill around the toggle. */}
      <div
        className={cn(
          "flex min-w-0 max-w-48 items-center gap-2",
          floating && cn("pointer-events-auto", mac ? "ml-[112px]" : "ml-11"),
        )}
      >
        {offBoard ? (
          <button
            type="button"
            aria-label="Back to board"
            onClick={toBoard}
            className={cn(
              "flex shrink-0 items-center justify-center text-ink-soft transition-colors hover:text-ink",
              iconButton,
            )}
          >
            <Icon icon={ArrowLeft} className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={chatOpen}
          aria-label={chatOpen ? "Close chat" : "Open chat"}
          title={chatOpen ? "Close chat" : "Open chat"}
          onClick={() => setChatOpen(!chatOpen)}
          className={cn(
            "flex shrink-0 items-center justify-center text-ink-soft transition-colors hover:text-ink",
            iconButton,
          )}
        >
          <Icon icon={MessageCircle} className="size-3.5" />
        </button>
        {/* The trail belongs to whichever pane is leftmost. With the dock open the chat
            header already renders one (`chat/chat-header.tsx`), so showing it here too is
            the same trail twice; the prototype gates the top-bar copy on the chat being
            shut (`app/s/[slug]/page.tsx` — `showLocationTrail={!chatOpen}`). `TopBar`
            renders on session routes only, so `chatOpen` IS the dock's state here. */}
        {chatOpen ? null : (
          <div className={cn("min-w-0", floating && cn("rounded-full py-1 pr-3 pl-2.5", chip))}>
            <Trail {...trail} />
          </div>
        )}
      </div>

      {/* CENTER slot: the available-lens projection for the selected generation. It remains
          present on non-board views with no active segment; choosing one returns to its board.
          The SLOT drags the window: it is titlebar, and the empty run either side of the rail
          is the widest grip the bar has. Only the rail itself opts out (`mx-auto`, not
          `justify-center`, so an overflowing rail scrolls from its left edge instead of
          clipping it). */}
      <div
        data-slot="lens-switcher"
        className="flex min-w-0 items-center overflow-x-auto @max-[640px]:col-span-2 @max-[640px]:row-start-2"
      >
        <LensSwitcher
          key={`${review?.id ?? slug}:${selectedGeneration}`}
          lenses={lenses}
          reviewId={review?.id ?? slug}
          generation={selectedGeneration}
          selected={query.view === "board" ? effectiveLens : null}
          onSelect={onLens}
          flaggedOpenCount={flaggedOpenCount}
          className={cn(
            "app-region-no-drag mx-auto shrink-0",
            floating && cn("pointer-events-auto", chip),
          )}
        />
      </div>

      {/* RIGHT slot: the History · Diff pills. ONE group for the semantics
          (label, roving focus, selection), TWO outlines for the look — History is a
          ledger and joins only once a round has completed, so it carries its own
          round outline; Map and Diff share one, split by a hairline. The wrapping
          div is presentation: `ToggleGroup`'s composite registers its members by
          context, not by direct-child position, so nesting keeps arrow keys. */}
      <div
        className={cn(
          // No `min-w-0` here: the pills are the column's floor, so the rail's centring
          // gives way before the pills are squeezed.
          "app-region-no-drag flex items-center justify-end justify-self-end",
          floating && "pointer-events-auto",
        )}
      >
        <ToggleGroup
          value={pillValue}
          onValueChange={onPill}
          aria-label="Session view"
          className="gap-1.5 border-transparent bg-transparent p-0"
        >
          {historyEntry ? (
            <PillToggle
              entry={historyEntry}
              chatOpen={chatOpen}
              className={cn("border border-border bg-card", floating && chip)}
            />
          ) : null}
          <div className={cn("flex rounded-full border border-border bg-card", floating && chip)}>
            {mapDiff.map((entry, index) => (
              <Fragment key={entry.view}>
                {index > 0 ? (
                  <span className="w-px self-stretch bg-border" aria-hidden="true" />
                ) : null}
                {/* The joined halves square off their INNER edge with a side radius
                    rather than being clipped by an `overflow-hidden` parent (which the
                    prototype uses, having no focus ring to lose): a clipped member
                    swallows the focus outline, and arrow-key focus is the whole point
                    of the group. */}
                <PillToggle
                  entry={entry}
                  chatOpen={chatOpen}
                  className={index > 0 ? "rounded-l-none pl-2" : "rounded-r-none pr-2"}
                />
              </Fragment>
            ))}
          </div>
        </ToggleGroup>
      </div>
    </header>
  );
}
