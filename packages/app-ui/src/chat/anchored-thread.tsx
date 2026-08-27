import { cn } from "@rennet/ui";
import { Quote } from "lucide-react";
import { useRennetStore } from "../store";
import type { AnchoredThreadRow } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// AnchoredThread (C07, reconciliation 6, #466). A `review.quoteThreads` thread rendered
// transcript-side, keyed by the board ref that points at it. C7 owns only the CONTENT
// side — the board (C5) holds the anchor→thread ref and the marker. Focus follows
// `review.focusedThreadId`: when this thread is focused, it reads highlighted. A ref that
// points at a thread that is gone renders nothing (honest — no orphan card).
// ─────────────────────────────────────────────────────────────────────────────

export function AnchoredThread({ row }: { readonly row: AnchoredThreadRow }) {
  const thread = useRennetStore((s) => s.review.quoteThreads[row.threadId]);
  const focused = useRennetStore((s) => s.review.focusedThreadId === row.threadId);
  if (!thread) return null;

  return (
    <div
      data-testid="anchored-thread"
      data-thread-id={row.threadId}
      data-board-ref={row.boardRef}
      data-focused={focused}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/40 p-3",
        focused ? "border-accent-line ring-1 ring-accent-line" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Quote className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate italic">“{thread.anchor}”</span>
      </div>
      <div className="flex flex-col gap-2">
        {thread.messages.map((message, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: thread messages are an append-only positional list.
            key={index}
            className={cn(
              "font-serif text-sm leading-relaxed",
              message.author === "user" ? "text-foreground/95" : "text-foreground/90",
            )}
          >
            <span className="mr-1.5 text-2xs uppercase tracking-wide text-muted-foreground/70">
              {message.author === "user" ? "You" : "Orchestrator"}
            </span>
            {message.text}
          </div>
        ))}
      </div>
    </div>
  );
}
