import { cn } from "@rennet/ui";
import { useState } from "react";
import { type QuoteThread, useRennetStore } from "../store";
import { useAnchoredAsk } from "./anchored-ask";

export interface KeyedThread {
  readonly id: string;
  readonly thread: QuoteThread;
}

/** The tooltip stack: one section per thread covering the clicked span, each with its
 *  exchange and a reply input. `explain` threads read distinctly (a question to the
 *  orchestrator, never a review verb). Spans, not divs — the highlight lives inside a
 *  `<p>` and nested block/button elements are invalid there (spike keep-list note). */
export function QuoteThreadPopover({
  threads,
  inline = false,
}: {
  readonly threads: readonly KeyedThread[];
  readonly inline?: boolean;
}) {
  const addQuoteReply = useRennetStore((s) => s.reviewActions.addQuoteReply);
  const askFailures = useRennetStore((s) => s.review.quoteAskFailures);
  const sendAnchoredAsk = useAnchoredAsk();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <span
      className={cn(
        "block cursor-auto rounded-md border border-border bg-popover p-2.5 font-sans not-italic",
        inline ? "w-full" : "absolute bottom-full left-0 z-50 mb-1.5 w-[360px] shadow-lg",
      )}
    >
      {threads.map(({ id, thread }) => (
        <span
          key={id}
          data-thread-id={id}
          data-thread-kind={thread.kind ?? "comment"}
          className="mb-2 block last:mb-0"
        >
          <span className="mb-1 block text-2xs uppercase tracking-wide text-muted-foreground">
            {thread.kind === "explain" ? "Explain" : "Comment"}
          </span>
          <span className="mb-1.5 flex flex-col gap-1.5">
            {thread.messages.map((message, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: an append-only exchange is a stable positional list.
                key={index}
                className={cn(
                  "block text-12-5 leading-relaxed",
                  message.author === "user"
                    ? "self-end max-w-[280px] rounded-lg bg-secondary px-2.5 py-1.5 text-foreground/95"
                    : "text-foreground/85",
                )}
              >
                {message.text}
              </span>
            ))}
          </span>
          {askFailures[id] === undefined ? null : (
            // The retraction. Every call site appends the reviewer's message and clears the
            // draft box BEFORE the send, so a failed ask leaves their question sitting in the
            // thread looking exactly like one that landed — the reviewer's own words used as
            // false evidence of delivery (#888). This says it did not go, and prints the
            // daemon's reason verbatim (`board-view.tsx`'s `board-failed` shape).
            //
            // A `<span>` with `role="alert"`, not a `<p>`: this stack renders inside a `<p>`
            // and a nested block element is invalid there. `role="alert"` is deliberate and
            // is what the `t3-chat-*` slots lack — a dropped question is not a muted notice,
            // and a reviewer who has already looked away needs it announced.
            <span
              data-slot="quote-ask-failed"
              role="alert"
              className="mb-1.5 block text-2xs leading-relaxed text-destructive"
            >
              <span className="block font-medium">This question was not sent.</span>
              <span className="block text-destructive/85">{askFailures[id]}</span>
            </span>
          )}
          <textarea
            value={drafts[id] ?? ""}
            onChange={(event) => setDrafts((d) => ({ ...d, [id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const text = (drafts[id] ?? "").trim();
                if (text.length === 0) return;
                addQuoteReply(id, "user", text);
                setDrafts((d) => ({ ...d, [id]: "" }));
                void sendAnchoredAsk?.({
                  threadId: id,
                  question: text,
                  excerpt: thread.anchor,
                  ...(thread.codeRef === undefined ? {} : { codeRef: thread.codeRef }),
                  ...(thread.target === undefined ? {} : { target: thread.target }),
                  ...(thread.generation === undefined ? {} : { generation: thread.generation }),
                });
              }
            }}
            placeholder="Reply…"
            rows={1}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-12-5 leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
          />
        </span>
      ))}
    </span>
  );
}
