import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { previewMarkdownBlocks } from "../lib/preview-markdown";

export interface PreviewMarkdownProps {
  readonly markdown: string;
  readonly color: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly marginTop?: number;
  readonly empty?: string;
  readonly hideFinalReviewMarker?: boolean;
}

export function PreviewMarkdown({
  markdown,
  color,
  fontSize,
  lineHeight,
  marginTop = 0,
  empty,
  hideFinalReviewMarker = false,
}: PreviewMarkdownProps): ReactNode {
  const blocks = previewMarkdownBlocks(markdown, { hideFinalReviewMarker });
  if (blocks.length === 0 && empty === undefined) return null;
  return (
    <View style={{ marginTop }}>
      {blocks.length === 0 ? (
        <Text style={{ color, fontSize, lineHeight }}>{empty}</Text>
      ) : (
        blocks.map((block, blockIndex) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: preview blocks are immutable and may repeat exactly.
            key={`${block.kind}:${blockIndex}`}
            accessibilityRole={block.kind === "heading" ? "header" : undefined}
            style={{
              color,
              fontSize,
              lineHeight,
              fontWeight: block.kind === "heading" ? "600" : "400",
              marginTop: blockIndex === 0 ? 0 : 8,
            }}
          >
            {block.inlines.map((inline, inlineIndex) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable inline tokens may repeat exactly.
                key={`${inline.kind}:${inlineIndex}`}
                style={{ fontWeight: inline.kind === "strong" ? "700" : undefined }}
              >
                {inline.text}
              </Text>
            ))}
          </Text>
        ))
      )}
    </View>
  );
}
