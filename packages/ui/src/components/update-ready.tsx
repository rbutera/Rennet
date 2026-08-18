import type { UpdateReadyInfo } from "@rennet/protocol";
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
      className={`${className} chrome-mark-update`}
      aria-label={updateActionLabel(ready)}
      title={updateActionLabel(ready)}
      onClick={openPrompt}
    >
      <RennetBrandMark size={size} />
      <span className="chrome-mark-badge" aria-hidden="true" />
    </button>
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
  if (!ready || !promptOpen) return null;
  const heading = ready.version ? `Restart into ${ready.version}?` : "Restart into the update?";
  return (
    <div className="command-palette-backdrop" role="presentation">
      {/* Click-away scrim, matching the palette idiom: behind the dialog, never hit by it. */}
      <button
        type="button"
        className="update-prompt-scrim"
        aria-label="Dismiss update prompt"
        onClick={closePrompt}
      />
      <div className="update-prompt" role="dialog" aria-modal="true" aria-label={heading}>
        <h2>{heading}</h2>
        <p>The new version is downloaded. Rennet restarts and comes back where you left off.</p>
        <div className="update-prompt-actions">
          <button type="button" className="update-prompt-apply" onClick={onApply}>
            Restart now
          </button>
          <button type="button" className="update-prompt-later" onClick={closePrompt}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
