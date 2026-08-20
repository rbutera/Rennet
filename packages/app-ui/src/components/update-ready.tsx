import type { UpdateReadyInfo } from "@rennet/protocol";
import {
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rennet/ui";
import { create } from "zustand";
import { RennetBrandMark } from "./brand-mark";

// Host-app update readiness (spec: desktop-update-notification). The host bridge
// pushes "an update is downloaded and ready"; the chrome logo grows a corner badge
// and clicking it opens the restart prompt. Hosts without an updater (browser
// shell, tests, unsigned macOS) never push, so the store stays inert and every
// mark renders exactly as before. Module-level store, same lift as viewStore: the
// badge must show on chrome marks across unrelated component trees.

interface UpdateReadyState {
  ready: UpdateReadyInfo | null;
  promptOpen: boolean;
  markReady(info: UpdateReadyInfo): void;
  openPrompt(): void;
  closePrompt(): void;
}

export const useUpdateReady = create<UpdateReadyState>((set) => ({
  ready: null,
  promptOpen: false,
  markReady: (info) => set({ ready: info }),
  openPrompt: () => set({ promptOpen: true }),
  closePrompt: () => set({ promptOpen: false }),
}));

function updateActionLabel(ready: UpdateReadyInfo): string {
  return ready.version
    ? `Update ready — restart into ${ready.version}`
    : "Update ready — restart to apply";
}

/**
 * The chrome Rennet mark: a plain decorative mark until an update is ready, then a
 * badged button opening the restart prompt. The aria-label carries the meaning —
 * the dot is a redundant non-text cue, never color-alone.
 */
export function ChromeMark({ size, className }: { size: number; className: string }) {
  const ready = useUpdateReady((state) => state.ready);
  const openPrompt = useUpdateReady((state) => state.openPrompt);
  if (!ready) {
    return (
      <span className={className} aria-hidden="true">
        <RennetBrandMark size={size} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} chrome-mark-update relative m-0 cursor-pointer border-0 bg-transparent p-0 text-inherit`}
      aria-label={updateActionLabel(ready)}
      title={updateActionLabel(ready)}
      onClick={openPrompt}
    >
      <RennetBrandMark size={size} />
      <span
        className="chrome-mark-badge absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-accent shadow-[0_0_0_1px_var(--rn-surface)]"
        aria-hidden="true"
      />
    </button>
  );
}

/** Where the "Documentation" row opens (the static docsite; opens in the OS browser). */
const DOCS_URL = "https://docs.rennet.dev";

/**
 * The top-left chrome logo as an app menu (issue: settings discoverability after the
 * menu-bar route was dropped). Clicking the Rennet mark opens an anchored panel of
 * app-level destinations — Settings, Back to projects, Documentation — plus, when an
 * update is staged, a highlighted "Restart to update" row and the same corner badge
 * `ChromeMark` grows. The logo ALWAYS opens this panel: one consistent behavior, the
 * update surfaced as a row inside it rather than a second click target. Dismisses on
 * outside-click or Escape; picking a row runs its action and closes.
 */
export function ChromeMenu({
  size,
  className,
  version,
  canBackToProjects,
  onOpenSettings,
  onBackToProjects,
}: {
  size: number;
  className: string;
  /** Current app version for the footer line; absent on hosts that don't report one. */
  version?: string;
  /** Whether "Back to projects" applies (hidden on the projects root itself). */
  canBackToProjects: boolean;
  onOpenSettings(): void;
  onBackToProjects(): void;
}) {
  const ready = useUpdateReady((state) => state.ready);
  const openPrompt = useUpdateReady((state) => state.openPrompt);

  // Layout separated from colour: the update row swaps in the accent colours, and a
  // combined class string would let base `text-ink`/`bg-transparent` win by source
  // order in the emitted CSS and silently drop the highlight.
  const itemBase =
    "chrome-menu-item flex w-full cursor-pointer items-center gap-2 rounded-chip border-0 px-2.5 py-2 text-left font-sans text-base font-medium no-underline";
  const itemClass = `${itemBase} bg-transparent text-ink hover:bg-raised`;

  // The kit Menu owns the outside-click + Escape dismissal and item activation that
  // this component hand-rolled before; picking a row runs its action and closes.
  // modal={false}: the old menu let an outside mousedown close it AND the click
  // continue to the element beneath (no backdrop) — modal mode would swallow that
  // click, so non-modal preserves the click-through behaviour.
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={`${className} chrome-menu-trigger relative m-0 cursor-pointer border-0 bg-transparent p-0 text-inherit`}
            aria-label="Rennet menu"
          />
        }
      >
        <RennetBrandMark size={size} />
        {ready ? (
          <span
            className="chrome-mark-badge absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-accent shadow-[0_0_0_1px_var(--rn-surface)]"
            aria-hidden="true"
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="chrome-menu-panel w-auto min-w-[220px] gap-0.5 rounded-control border border-line bg-overlay p-1.5 shadow-overlay"
      >
        <DropdownMenuItem className={itemClass} onClick={onOpenSettings}>
          Settings
        </DropdownMenuItem>
        {canBackToProjects ? (
          <DropdownMenuItem className={itemClass} onClick={onBackToProjects}>
            Back to projects
          </DropdownMenuItem>
        ) : null}
        {ready ? (
          <DropdownMenuItem
            className={`${itemBase} chrome-menu-update bg-accent-soft text-accent hover:bg-accent-soft`}
            onClick={openPrompt}
          >
            {updateActionLabel(ready)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className={itemClass}
          render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}
        >
          Documentation
        </DropdownMenuItem>
        {version ? (
          <p className="chrome-menu-version m-0 border-t border-line px-2.5 pb-1 pt-2 font-sans text-2xs text-ink-faint">
            Rennet v{version}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The restart-into-update confirm. Rendered once at the app root; opens only from
 * a badged mark. Dismissing keeps the badge and never re-prompts on its own — the
 * update NEVER applies without the user choosing it.
 */
export function UpdateReadyPrompt({ onApply }: { onApply: () => void }) {
  const ready = useUpdateReady((state) => state.ready);
  const promptOpen = useUpdateReady((state) => state.promptOpen);
  const closePrompt = useUpdateReady((state) => state.closePrompt);
  if (!ready) return null;
  const heading = ready.version ? `Restart into ${ready.version}?` : "Restart into the update?";
  // The kit Dialog owns the portal, backdrop, and focus management. The old prompt
  // hand-rolled only the scrim + a "Not now" / backdrop-click dismissal (no Escape,
  // no focus trap); the kit adds Escape and focus return as the standard modal
  // affordance. `aria-modal` is preserved. Closing (Escape / backdrop / Not now)
  // keeps the badge and never re-prompts — the update NEVER applies without the
  // user choosing it (Rule Zero: dismissal is less friction, not a gate).
  return (
    <Dialog
      open={promptOpen}
      onOpenChange={(open) => {
        if (!open) closePrompt();
      }}
    >
      <DialogContent
        aria-label={heading}
        aria-modal="true"
        showCloseButton={false}
        className="update-prompt block w-[min(400px,100%)] max-w-[min(400px,100%)] rounded-surface border border-line bg-overlay p-5 shadow-overlay ring-0"
      >
        <h2 className="m-0 mb-1.5 text-lg font-semibold text-ink">{heading}</h2>
        <p className="m-0 mb-4 text-base leading-relaxed text-ink-soft">
          The new version is downloaded. Rennet restarts and comes back where you left off.
        </p>
        <div className="update-prompt-actions flex gap-2">
          <button
            type="button"
            className="update-prompt-apply cursor-pointer rounded-control border border-accent-line bg-accent-fill px-3.5 py-2 font-sans text-sm font-semibold text-accent-ink"
            onClick={onApply}
          >
            Restart now
          </button>
          <button
            type="button"
            className="update-prompt-later cursor-pointer rounded-control border border-line bg-surface px-3.5 py-2 font-sans text-sm font-semibold text-ink hover:bg-raised"
            onClick={closePrompt}
          >
            Not now
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
