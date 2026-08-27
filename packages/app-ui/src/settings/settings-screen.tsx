import { cn } from "@rennet/ui";
import { ArrowLeft } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { settingsPath } from "../routes/url";
import { AppearancePage } from "./appearance";
import { EnvironmentsPage } from "./environments/environments-page";
import {
  parseSettingsPage,
  SETTINGS_PAGE_BY_ID,
  SETTINGS_PAGES,
  type SettingsPageMeta,
} from "./pages";
import { usePriorSurface } from "./prior-surface";
import { ShortcutsPage } from "./shortcuts";

// ─────────────────────────────────────────────────────────────────────────────
// The Settings takeover shell (C10 §1.1–1.2, claims 575–577). A full-view takeover
// that fills the outlet — the frame (`routes/layout.tsx`) keeps the sidebar and the
// chat-dock slot mounted OUTSIDE the outlet, so the chat and board survive the visit
// without this screen touching them (the "cooperate with shell/, do not unmount"
// rule). Header carries the back arrow and an `esc` hint; the left nav lists the
// four pages with icons.
//
// THE STRUCTURAL RULE (autopsy S2): the active page is read from the `/settings/:page`
// route PARAM through `parseSettingsPage` — never a shadowed `useState`. Each page is
// its own module reached by that param; the nav navigates the route, it does not flip
// a local variable.
//
// Escape leaves to the prior surface. It is handled on the focused root, not `window`,
// so a nested editor (a filter, a tracker field, a guidance rule) can intercept
// Escape with `stopPropagation` and clear itself BEFORE settings closes — the shape
// the Keyboard-Shortcuts and Projects pages depend on.
// ─────────────────────────────────────────────────────────────────────────────

/** An honest interim for a page whose module lands in a later C10 cluster. Reuses the
 *  frame's sanctioned placeholder shape rather than faking an unbuilt page's controls. */
function SettingsPagePending({ page }: { readonly page: SettingsPageMeta }) {
  return (
    <section data-settings-page={page.id} className="grid gap-2">
      <h2 className="text-sm font-medium text-ink">{page.label}</h2>
      <p className="max-w-[440px] text-xs text-ink-soft">
        This page lands with a later step of the Settings rebuild.
      </p>
    </section>
  );
}

function ActivePage({ page }: { readonly page: SettingsPageMeta }) {
  if (page.id === "environments") return <EnvironmentsPage />;
  if (page.id === "appearance") return <AppearancePage />;
  if (page.id === "keybindings") return <ShortcutsPage />;
  return <SettingsPagePending page={page} />;
}

export function SettingsScreen({ page }: { readonly page: string }) {
  const [, navigate] = useLocation();
  const getPriorSurface = usePriorSurface();
  const rootRef = useRef<HTMLDivElement>(null);

  const activeId = parseSettingsPage(page);
  const activeMeta = SETTINGS_PAGE_BY_ID[activeId];

  const leave = useCallback(() => {
    navigate(getPriorSurface(), { replace: true });
  }, [navigate, getPriorSurface]);

  // Focus the takeover on mount so Escape reaches the root handler even before the
  // reader clicks into a control (keydown on an element only fires with focus within).
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A nested editor that wants Escape stops propagation before it reaches here.
    if (event.key === "Escape") leave();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled here (not window) so a nested editor can intercept it with stopPropagation before settings closes
    <div
      ref={rootRef}
      data-screen="settings"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col overflow-hidden outline-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={leave}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="size-3.5" />
        </button>
        <span className="text-xs font-medium text-ink">Settings</span>
        <kbd className="ml-auto rounded border border-line px-1 py-0.5 text-2xs text-ink-soft">
          esc
        </kbd>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings pages"
          className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line px-2 py-4"
        >
          {SETTINGS_PAGES.map((p) => {
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => navigate(settingsPath(p.slug), { replace: true })}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
                  active ? "bg-raised text-ink" : "text-ink-soft hover:bg-raised/60 hover:text-ink",
                )}
              >
                <Icon icon={p.icon} className="size-3.5" />
                {p.label}
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-8 py-8">
            <ActivePage page={activeMeta} />
          </div>
        </div>
      </div>
    </div>
  );
}
