import { cn } from "@rennet/ui";
import { RichText } from "../review";

interface OutboundBlock {
  readonly kind: "heading" | "prose";
  readonly text: string;
}

const FINAL_REVIEW_MARKER = /\n*<!--\s*rennet:review:[0-9a-f]{64}\s*-->\s*$/;

function outboundBlocks(markdown: string, hideFinalReviewMarker: boolean): OutboundBlock[] {
  const blocks: OutboundBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n").trim();
    if (text) blocks.push({ kind: "prose", text });
    prose = [];
  };
  const visible = hideFinalReviewMarker ? markdown.replace(FINAL_REVIEW_MARKER, "") : markdown;
  for (const line of visible.split("\n")) {
    if (line.startsWith("## ")) {
      flushProse();
      blocks.push({ kind: "heading", text: line.slice(3).trim() });
    } else if (line.trim() === "") {
      flushProse();
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return blocks;
}

/** GitHub-facing Markdown used by both PR and review signing previews. */
export function OutboundMarkdown({
  markdown,
  patchsetId,
  hideFinalReviewMarker = false,
}: {
  readonly markdown: string;
  readonly patchsetId: string;
  readonly hideFinalReviewMarker?: boolean;
}) {
  return (
    <div className="flex flex-col">
      {outboundBlocks(markdown, hideFinalReviewMarker).map((block, index) => {
        const key = `${index}-${block.kind}-${block.text.slice(0, 16)}`;
        if (block.kind === "heading") {
          return (
            <h3
              key={key}
              className={cn("text-sm font-semibold text-foreground", index > 0 && "mt-4")}
            >
              {block.text}
            </h3>
          );
        }
        return (
          <RichText
            key={key}
            text={block.text}
            patchsetId={patchsetId}
            paragraphClassName={cn(
              "text-sm leading-relaxed text-foreground/85",
              index > 0 && "mt-2",
            )}
          />
        );
      })}
    </div>
  );
}
