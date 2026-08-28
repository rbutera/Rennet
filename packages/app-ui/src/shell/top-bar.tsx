import { Toggle, ToggleGroup } from "@rennet/ui";
import { ArrowLeft, PanelRightOpen } from "lucide-react";
import { useLocation, useRoute, useSearch } from "wouter";
import { Icon } from "../components/icon";
import { useRoundRecords, useRoundsUnavailable } from "../rounds/rounds-data";
import { DEFAULT_VIEW, ROUTES, readSessionQuery, type ViewKind, viewToggle } from "../routes/url";
import { useRennetStore } from "../store";
import { useSidebarTree } from "./sidebar-data";
import { Trail, type TrailProps } from "./trail";

// ─────────────────────────────────────────────────────────────────────────────
// The 56px session top-bar (C03 §4, R51). The frame renders it on session routes
// only (the 40px takeover tier belongs to each takeover surface — reconciliation
// 6). A three-column grid: LEFT slot (back arrow exactly when `?view` is not the
// board; the chat-expand control when the chat is collapsed; then the two-line
// trail), a CENTERED lens-switcher slot C5 fills, and the RIGHT slot's History ·
// Map · Diff pill — a C2 `ToggleGroup` over `?view`, selection DERIVED from the
// URL, toggling navigating with `viewToggle` (replace).
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
  // …and ALSO present when the rounds cannot be read at all (review finding 9): dropping the
  // toggle then would hide the disclosure behind an absence that reads as "no rounds", and
  // the reviewer would have no way to reach the reason. Presence still tracks the truth —
  // it is just that "unknown" is a different truth from "none".
  const roundsUnavailable = useRoundsUnavailable(slug);
  const pill =
    roundRecords.length > 0 || roundsUnavailable !== undefined
      ? PILL
      : PILL.filter((p) => p.view !== "rounds");
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

  return (
    <header
      data-slot="session-top-bar"
      className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-line bg-canvas px-3"
    >
      {/* LEFT slot: back arrow (off-board), chat-expand (chat collapsed), trail. */}
      <div className="flex min-w-0 items-center gap-2">
        {offBoard ? (
          <button
            type="button"
            aria-label="Back to board"
            onClick={toBoard}
            className="flex size-7 shrink-0 items-center justify-center rounded-chip text-ink-soft transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon icon={ArrowLeft} className="size-4" />
          </button>
        ) : null}
        {!chatOpen ? (
          <button
            type="button"
            aria-label="Expand chat"
            onClick={() => setChatOpen(true)}
            className="flex size-7 shrink-0 items-center justify-center rounded-chip text-ink-soft transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon icon={PanelRightOpen} className="size-4" />
          </button>
        ) : null}
        <Trail {...trail} />
      </div>

      {/* CENTER slot: the lens switcher — an empty named slot C5 fills. */}
      <div data-slot="lens-switcher" className="flex items-center justify-center" />

      {/* RIGHT slot: the History · Map · Diff pill. */}
      <div className="flex items-center justify-end">
        <ToggleGroup value={pillValue} onValueChange={onPill} aria-label="Session view">
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
