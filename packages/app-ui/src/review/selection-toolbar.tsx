import { cn } from "@rennet/ui";
import { GitPullRequestArrow, MessageSquare, Pencil, Sparkles, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/icon";
import { useFlightBatcher } from "../handoff/exit-flight";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// ProseSelectionLayer (C4, packet keep-list). The panel is positioned INSIDE the
// scrolling container so it travels with the anchored text. Comment/Explain mint a quote
// thread on the real `review` slice and focus it (so C5 can open the tooltip); Request
// Changes mints the thread AND stages an ask that CLAIMS it (a distinct threadId, so the
// exit counts once). Slice is read directly — no `useCodeComments()`, no `store?.`
// (reconciliations 1 and 8).
// ─────────────────────────────────────────────────────────────────────────────

/** The opener for an Explain thread — a question to the orchestrator, never a review verb. */
const EXPLAIN_OPENER = "Explain this passage.";

// Revise's EXECUTION is gated to cluster 8 (B11/B9's span-rework command, the `reviseDraftSpan`
// seam). The affordance renders — the reviewer can open it and draft an instruction (packet task
// 4.3) — but it must NOT pretend to run: it previously called the no-op `onRevise` and dismissed as
// though the rework began. Until the seam is bound the control is disabled and says so. Cluster 8
// flips this to `true` when `reviseDraftSpan` executes for real.
const REVISE_WIRED = false;

/**
 * The board-anchor identity of a selection (finding 2): the element id it landed in
 * (`data-element-id`) and the board generation (`data-generation`), read from the DOM
 * so a minted quote thread is scoped to exactly this element in this generation. A
 * selection outside a board (draft mode) resolves neither, so its thread carries no
 * durable board highlight.
 */
function scopeOfRange(range: Range): { target?: string; generation?: string } {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return {
    target: el?.closest("[data-element-id]")?.getAttribute("data-element-id") ?? undefined,
    generation: el?.closest("[data-generation]")?.getAttribute("data-generation") ?? undefined,
  };
}

export interface DraftHandlers {
  onRevise: (quote: string, instruction: string) => void;
  onDrop: (quote: string) => void;
  /** Returns the provenance answer for a span (shown inline in the panel). */
  explain: (quote: string) => string;
}

type Mode = "toolbar" | "comment" | "comment-rc" | "revise" | "explain";

export function ProseSelectionLayer({
  children,
  draftHandlers,
}: {
  children: ReactNode;
  /** When set, the toolbar carries draft verbs (Revise / Drop / Explain) instead of board verbs. */
  draftHandlers?: DraftHandlers;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    quote: string;
    placement: "above" | "below";
    /** The board-anchor identity of the selection (finding 2), if it landed in a board. */
    target?: string;
    generation?: string;
  } | null>(null);
  const [mode, setMode] = useState<Mode>("toolbar");
  const [draft, setDraft] = useState("");
  const [explanation, setExplanation] = useState("");
  const { addQuoteComment, setFocusedThread, stageAsk } = useRennetStore((s) => s.reviewActions);
  const flight = useFlightBatcher();

  const dismiss = useCallback(() => {
    setAnchor(null);
    setMode("toolbar");
    setDraft("");
  }, []);

  useEffect(() => {
    function handleMouseUp(event: MouseEvent) {
      // Clicks inside the floating panel must not re-anchor or dismiss.
      if (panelRef.current?.contains(event.target as Node)) return;
      // A release whose TARGET is outside the prose container dismisses — even if the
      // browser kept the prior internal selection alive (which would otherwise re-anchor
      // the toolbar on an outside click).
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        dismiss();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !containerRef.current) {
        dismiss();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!containerRef.current.contains(range.commonAncestorContainer)) {
        dismiss();
        return;
      }
      const text = selection.toString().trim();
      if (text.length === 0) {
        dismiss();
        return;
      }
      const rect = range.getBoundingClientRect();
      const wrapRect = containerRef.current.getBoundingClientRect();
      // Flip below when the selection sits too close to the viewport top for the
      // tallest panel mode (the comment/revise editor), so nothing clips.
      const placement: "above" | "below" = rect.top < 240 ? "below" : "above";
      const scope = scopeOfRange(range);
      setMode("toolbar");
      setAnchor({
        top: (placement === "below" ? rect.bottom : rect.top) - wrapRect.top,
        left: rect.left - wrapRect.left + rect.width / 2,
        quote: text,
        placement,
        ...scope,
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") dismiss();
    }

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismiss]);

  function startThread(opener: string, kind: "comment" | "explain" = "comment") {
    if (!anchor) return;
    const id = addQuoteComment(anchor.quote, opener, kind, {
      target: anchor.target,
      generation: anchor.generation,
    });
    setFocusedThread(id);
    window.getSelection()?.removeAllRanges();
  }

  function handleSave() {
    const text = draft.trim();
    if (text.length > 0) startThread(text);
    dismiss();
  }

  function stageRequestChange() {
    if (!anchor) return;
    const text = draft.trim();
    if (text.length === 0) return;
    // Mint the thread, then stage an ask that keeps the quoted span as its source
    // provenance (`anchor`) AND names the thread it CLAIMS (`threadId`) — so the exit
    // tally counts the claimed thread once, without conflating source with claim.
    const id = addQuoteComment(anchor.quote, text, "comment", {
      target: anchor.target,
      generation: anchor.generation,
    });
    // Identity is the minted thread id — unique per selection, so two request-changes on identical
    // prose (or the same span twice) stay separate asks instead of collapsing on the quote text.
    stageAsk({ id, anchor: anchor.quote, type: "request-change", body: text, threadId: id });
    flight.signal(); // the quote request-change stages one ask and flies one bubble (batched)
    setFocusedThread(id);
    window.getSelection()?.removeAllRanges();
    dismiss();
  }

  function handleEditorSave() {
    if (mode === "revise") {
      // Gated to cluster 8: do NOT fake success. While unwired, the Rework control is disabled and
      // the panel says so, so this stays a no-op that keeps the editor open rather than dismissing
      // as though the rework was queued. When cluster 8 binds the seam it flips `REVISE_WIRED`.
      if (!REVISE_WIRED) return;
      const instruction = draft.trim();
      if (anchor && draftHandlers && instruction.length > 0)
        draftHandlers.onRevise(anchor.quote, instruction);
      window.getSelection()?.removeAllRanges();
      dismiss();
      return;
    }
    if (mode === "comment-rc") {
      stageRequestChange();
      return;
    }
    handleSave();
  }

  return (
    // Positioned wrapper: the panel is absolute inside the board, so it scrolls with
    // the text it anchors to instead of dying on scroll.
    <div ref={containerRef} className="relative">
      {children}
      {anchor && (
        <div
          ref={panelRef}
          className={cn(
            "absolute z-50 -translate-x-1/2",
            anchor.placement === "above" && "-translate-y-full",
          )}
          style={{
            top: anchor.placement === "above" ? anchor.top - 8 : anchor.top + 8,
            left: anchor.left,
          }}
        >
          {mode === "toolbar" ? (
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-popover px-1 py-0.5 shadow-overlay">
              {draftHandlers ? (
                <>
                  <button
                    type="button"
                    onClick={() => setMode("revise")}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-foreground/90 hover:bg-secondary"
                  >
                    <Icon icon={Pencil} className="size-3" />
                    Revise
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (anchor) draftHandlers.onDrop(anchor.quote);
                      window.getSelection()?.removeAllRanges();
                      dismiss();
                    }}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Icon icon={Trash2} className="size-3" />
                    Drop
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (anchor) setExplanation(draftHandlers.explain(anchor.quote));
                      setMode("explain");
                    }}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Icon icon={Sparkles} className="size-3" />
                    Explain
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setMode("comment")}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-foreground/90 hover:bg-secondary"
                  >
                    <Icon icon={MessageSquare} className="size-3" />
                    Comment
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("comment-rc")}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-foreground/90 hover:bg-secondary"
                  >
                    <Icon icon={GitPullRequestArrow} className="size-3" />
                    Request Changes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      startThread(EXPLAIN_OPENER, "explain");
                      dismiss();
                    }}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Icon icon={Sparkles} className="size-3" />
                    Explain
                  </button>
                </>
              )}
            </div>
          ) : mode === "explain" ? (
            <div className="w-[340px] rounded-md border border-border bg-popover p-2.5 shadow-overlay">
              <p className="text-sm leading-relaxed text-foreground/85">{explanation}</p>
            </div>
          ) : (
            <div className="w-[340px] rounded-md border border-border bg-popover p-2.5 shadow-overlay">
              <p className="mb-1.5 line-clamp-2 border-l-2 border-border pl-2 text-2xs italic leading-snug text-muted-foreground">
                {anchor.quote}
              </p>
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the editor opens on an explicit user action (a toolbar verb); focus belongs in the box.
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    handleEditorSave();
                  }
                }}
                placeholder={
                  mode === "revise"
                    ? "Tell the orchestrator how to rework this…"
                    : mode === "comment-rc"
                      ? "What change are you requesting?"
                      : "Ask a question or leave a comment…"
                }
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
              />
              {/* Revise is gated (cluster 8): the panel states the truth rather than faking a run. */}
              {mode === "revise" && !REVISE_WIRED && (
                <p className="mt-1.5 text-2xs leading-snug text-muted-foreground">
                  Revise runs with the next round — not available yet.
                </p>
              )}
              <div className="mt-1.5 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={dismiss}
                  className="rounded-md px-2.5 py-1 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditorSave}
                  disabled={mode === "revise" && !REVISE_WIRED}
                  title={
                    mode === "revise" && !REVISE_WIRED
                      ? "Revise runs with the next round — not available yet."
                      : undefined
                  }
                  className="rounded-md bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary"
                >
                  {mode === "revise" ? "Rework" : mode === "comment-rc" ? "Stage" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
