import { cn } from "@rennet/ui";
import { ArrowUp, FileCode, MessageSquare, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Composer (C07, ported from the spike's `InputBar`). Auto-grow textarea (Enter-sends /
// Shift-Enter-newline / IME-safe), send button, image-paste → local image badges.
//
// RECONCILIATION 5: badges read the REAL `review` slice — comment badges from
// `review.codeComments`, quote badges from `review.quoteThreads`; removal calls the real
// `reviewActions.clearCodeComment` / `removeQuoteComment`. No spike comment-provider shim,
// no `store?.` guard. Image badges are local composer state. Sending fires the seam's
// `review.ask` (via `onSend`) and clears the LOCAL image badges; the comment/quote badges
// mirror the live `review` slice and are not cleared here — they persist until removed
// through their own X (or by the review advancing). No ask staging (C8), no command
// effects (B10). Presence follows the real in-flight stream state.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_TEXTAREA_HEIGHT = 36;
const MAX_TEXTAREA_HEIGHT = 200;

type ComposerBadge =
  | {
      readonly id: string;
      readonly kind: "image";
      readonly name: string;
      readonly thumbnailUrl: string;
    }
  | {
      readonly id: string;
      readonly kind: "comment";
      readonly path: string;
      readonly line: number;
      readonly text: string;
    }
  | { readonly id: string; readonly kind: "quote"; readonly quote: string; readonly text: string };

function commentBadgeId(path: string, line: number): string {
  return `comment-${path}-${line}`;
}

function ComposerBadgePill({
  badge,
  onRemove,
}: {
  readonly badge: ComposerBadge;
  readonly onRemove: () => void;
}) {
  return (
    <span className="group relative flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 py-1 pl-1 pr-1.5 text-xs text-foreground/90">
      {badge.kind === "image" ? (
        <img src={badge.thumbnailUrl} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
      ) : (
        <MessageSquare className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="max-w-[160px] truncate">
        {badge.kind === "image"
          ? badge.name
          : badge.kind === "quote"
            ? `“${badge.quote}”`
            : "1 comment"}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${
          badge.kind === "image"
            ? badge.name
            : badge.kind === "quote"
              ? "quoted-text comment"
              : `comment on line ${badge.line}`
        } reference`}
        className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
      {badge.kind === "comment" && (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-64 max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-2.5 text-foreground shadow-lg group-hover:block">
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <FileCode className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">{badge.path}</span>
          </div>
          <div className="mt-1 font-mono text-2xs text-primary">L{badge.line}</div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
            {badge.text}
          </p>
        </div>
      )}
    </span>
  );
}

export function Composer({
  onSend,
  inFlight = false,
  draft,
}: {
  readonly onSend: (message: string) => void;
  /** True while an orchestrator turn is streaming — the presence affordance follows this. */
  readonly inFlight?: boolean;
  /** The opening ask handed over on the mint (`?ask=`). Seeded into the box once per
   *  distinct value, so the reviewer lands looking at what they typed in New Chat. */
  readonly draft?: string;
}) {
  const codeComments = useRennetStore((s) => s.review.codeComments);
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const { clearCodeComment, removeQuoteComment } = useRennetStore((s) => s.reviewActions);

  const [value, setValue] = useState("");
  const [imageBadges, setImageBadges] = useState<Array<Extract<ComposerBadge, { kind: "image" }>>>(
    [],
  );
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Seed the box from the mint's opening ask. The dock is mounted ONCE by the layout and
  // never unmounts on navigation, so this cannot be initial state — the ask arrives when
  // the route changes, long after mount. Seeded once per distinct value: the reviewer can
  // then clear or edit it freely without the URL pushing it back on the next render.
  const seededRef = useRef<string | undefined>(undefined);
  if (draft !== undefined && draft !== seededRef.current) {
    seededRef.current = draft;
    if (draft !== value) setValue(draft);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the intended re-measure trigger — the textarea auto-grows each time the text changes — not a body reference.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT,
    );
    textarea.style.height = `${nextHeight}px`;
  }, [value]);

  const commentBadges: ComposerBadge[] = Object.entries(codeComments).flatMap(([path, lineMap]) =>
    Object.entries(lineMap).map(([line, text]) => ({
      id: commentBadgeId(path, Number(line)),
      kind: "comment" as const,
      path,
      line: Number(line),
      text,
    })),
  );
  const quoteBadges: ComposerBadge[] = Object.entries(quoteThreads).map(([id, thread]) => ({
    id,
    kind: "quote" as const,
    quote: thread.anchor,
    text: thread.messages[0]?.text ?? "",
  }));
  const badges: ComposerBadge[] = [...commentBadges, ...quoteBadges, ...imageBadges];

  function handleAddImage(file: File) {
    const thumbnailUrl = URL.createObjectURL(file);
    setImageBadges((prev) => [
      ...prev,
      {
        id: `image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: "image",
        name: file.name || "image.png",
        thumbnailUrl,
      },
    ]);
  }

  function handleRemoveBadge(badge: ComposerBadge) {
    if (badge.kind === "image") {
      URL.revokeObjectURL(badge.thumbnailUrl);
      setImageBadges((prev) => prev.filter((b) => b.id !== badge.id));
    } else if (badge.kind === "quote") {
      removeQuoteComment(badge.id);
    } else {
      clearCodeComment(badge.path, badge.line);
    }
  }

  function handleSubmit() {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    // Clear only the LOCAL image badges (revoking their object URLs). Comment/quote badges
    // live in the review slice and are left as-is — they are not staged references here.
    for (const badge of imageBadges) URL.revokeObjectURL(badge.thumbnailUrl);
    setImageBadges([]);
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-[720px] flex-col gap-2 px-1">
        {inFlight && (
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-model"
              aria-hidden="true"
            />
            <span>The orchestrator is working…</span>
          </div>
        )}
        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {badges.map((badge) => (
              <ComposerBadgePill
                key={badge.id}
                badge={badge}
                onRemove={() => handleRemoveBadge(badge)}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229)
                return;
              event.preventDefault();
              handleSubmit();
            }}
            onPaste={(event) => {
              const items = event.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (file) {
                    event.preventDefault();
                    handleAddImage(file);
                  }
                  break;
                }
              }
            }}
            placeholder="message the orchestrator"
            rows={1}
            aria-label="Message the orchestrator"
            className="flex-1 resize-none overflow-y-auto rounded-md border border-border bg-card/40 px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
            style={{ height: MIN_TEXTAREA_HEIGHT }}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim()}
            aria-label="Send"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed",
              value.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
