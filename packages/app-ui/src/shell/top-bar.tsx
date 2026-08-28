import { cn, Toggle, ToggleGroup } from "@rennet/ui";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useLocation, useRoute, useSearch } from "wouter";
import { Icon } from "../components/icon";
import { useRoundRecords } from "../rounds/rounds-data";
import { DEFAULT_VIEW, ROUTES, readSessionQuery, type ViewKind, viewToggle } from "../routes/url";
import { useRennetStore } from "../store";
import { cornerSlotOwner, useMacTrafficLights } from "./corner-slot";
import { useSidebarTree } from "./sidebar-data";
import { Trail, type TrailProps } from "./trail";

// ─────────────────────────────────────────────────────────────────────────────
// The 56px session top-bar (C03 §4, R51). The frame renders it on session routes
// only (the 40px takeover tier belongs to each takeover surface — reconciliation
// 6). A three-column grid: LEFT slot (back arrow exactly when `?view` is not the
// board; then the app's ONE chat open/close toggle; then the two-line trail), a
// CENTERED lens-switcher slot C5 fills, and the RIGHT slot's History · Map · Diff
// pill — a C2 `ToggleGroup` over `?view`, selection DERIVED from the URL, toggling
// navigating with `viewToggle` (replace).
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

/** The pill's three explicit views, in order, mapped to their labels. */
const PILL: ReadonlyArray<{
  readonly view: Extract<ViewKind, "rounds" | "map" | "diff">;
  readonly label: string;
}> = [
  { view: "rounds", label: "History" },
  { view: "map", label: "Map" },
  { view: "diff", label: "Diff" },
];

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
  const query = readSessionQuery(new URLSearchParams(search));
  const current = { lens: query.lens, file: query.file ?? undefined };
  const offBoard = query.view !== DEFAULT_VIEW;
  // The History (rounds) toggle is present EXACTLY when a round has completed (C09 §6.2) —
  // the derived-presence url.ts gates `?view=rounds` on, never a disabled tab. With no
  // completed round it drops from the pill entirely (honest-absent by default, since no
  // rounds runtime is bound yet — Reconciliation 1). Map · Diff are always present.
  const roundRecords = useRoundRecords(slug);
  const pill = roundRecords.length > 0 ? PILL : PILL.filter((p) => p.view !== "rounds");
  // A pill toggle is selected only for its three explicit views; the board and
  // handoff select none (value = []), never the "" sentinel (S6).
  const pillValue = PILL.some((p) => p.view === query.view) ? [query.view] : [];

  // Resolve the trail from the active session row (empty until B9 — then just the slug).
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

  // The chip skin — translucent, blurred, hairlined. Used only by the floating layer.
  const chip = "border border-line/60 bg-surface/70 shadow-sm backdrop-blur-md";
  const iconButton = floating
    ? cn("size-8 rounded-full", chip)
    : "size-7 rounded-chip hover:bg-raised";
  return (
    <header
      data-slot="session-top-bar"
      data-floating={floating}
      className={cn(
        "grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3",
        floating
          ? "pointer-events-none absolute inset-x-0 top-0 z-30 h-11"
          : "h-14 shrink-0 border-b border-line bg-canvas",
      )}
    >
      {/* LEFT slot: back arrow (off-board), the one chat toggle, trail. In state 3 it
        starts clear of the floating corner slot — which on darwin reserves the real
        traffic lights, and elsewhere is just the pill around the toggle. */}
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
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
          <Icon icon={MessageSquare} className="size-4" />
        </button>
        <div className={cn("min-w-0", floating && cn("rounded-full py-1 pr-3 pl-2.5", chip))}>
          <Trail {...trail} />
        </div>
      </div>

      {/* CENTER slot: the lens switcher — an empty named slot C5 fills. Its chips get
        the same skin, so whatever C5 mounts joins the floating layer instead of
        painting an opaque block over the full-bleed view. */}
      <div
        data-slot="lens-switcher"
        className={cn(
          "flex items-center justify-center",
          floating &&
            "pointer-events-auto [&_[role=tablist]]:border [&_[role=tablist]]:border-line/60 [&_[role=tablist]]:bg-surface/70 [&_[role=tablist]]:shadow-sm [&_[role=tablist]]:backdrop-blur-md",
        )}
      />

      {/* RIGHT slot: the History · Map · Diff pill. */}
      <div className={cn("flex items-center justify-end", floating && "pointer-events-auto")}>
        <ToggleGroup
          value={pillValue}
          onValueChange={onPill}
          aria-label="Session view"
          className={floating ? chip : undefined}
        >
          {pill.map(({ view, label }) => (
            <Toggle key={view} value={view} size="sm">
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </header>
  );
}
