import { cn } from "@rennet/ui";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/icon";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE line-comment editor (C4, autopsy keep-list; reconciliation 2). Its OWN module,
// not nested in code-block, so a board excerpt, code-block, and C6's diff view each
// import it without the rest of code-block. Pure and callback-driven — the caller wires
// onSave/onRequestChanges to the review slice, so the SAME comment object mints from any
// surface (headline invariant, verification 8.2).
// ─────────────────────────────────────────────────────────────────────────────

export interface LineCommentEditorProps {
  /** Shown top-right, e.g. "L42". */
  readonly lineLabel: string;
  readonly initialText: string;
  readonly hasComment: boolean;
  readonly onCancel: () => void;
  /** null clears the comment (Delete, or emptied text). */
  readonly onSave: (text: string | null) => void;
  /** Saves the comment AND stages a request-change ask (the caller wires the store). */
  readonly onRequestChanges: (text: string) => void;
  readonly className?: string;
}

export function LineCommentEditor({
  lineLabel,
  initialText,
  hasComment,
  onCancel,
  onSave,
  onRequestChanges,
  className,
}: LineCommentEditorProps) {
  const [draft, setDraft] = useState(initialText);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    draftRef.current?.focus();
  }, []);

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-2xs font-medium text-foreground">
          <Icon icon={MessageSquare} className="size-3 text-muted-foreground" />
          Local Comment
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">Comment on line {lineLabel}</span>
      </div>
      <textarea
        ref={draftRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Leave a comment on this line…"
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 font-sans text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        {hasComment ? (
          <button
            type="button"
            onClick={() => onSave(null)}
            className="rounded-md px-2 py-1 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = draft.trim();
              if (trimmed.length > 0) onRequestChanges(trimmed);
            }}
            className={cn(
              "rounded-md border border-destructive/50 px-2.5 py-1 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/10",
            )}
          >
            Request Changes
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = draft.trim();
              onSave(trimmed.length > 0 ? trimmed : null);
            }}
            className="rounded-md bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
