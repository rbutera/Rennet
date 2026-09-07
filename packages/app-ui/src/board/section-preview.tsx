import type { HostElement } from "@rennet/protocol";
import { Fragment } from "react";
import type { ElementOf } from "./registry";

export interface SectionPreviewEntry {
  readonly id: string;
  readonly text: string;
}

export type SectionPreview =
  | { readonly kind: "headings"; readonly entries: readonly SectionPreviewEntry[] }
  | { readonly kind: "paragraph"; readonly entry: SectionPreviewEntry }
  | { readonly kind: "empty" };

function normalized(text: string): string {
  return text.replace(/[`*#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Old boards have only a statement. Keep its full text in the body, with a short label here.
 *  An authored title is bounded the same way: the prompt asks for a short heading, and a
 *  paragraph that arrives in the `title` field is no more a navigation label than one in
 *  the statement. */
export function decisionHeading(data: ElementOf<"decision">["data"]): string {
  const title = data.title?.trim();
  const firstLine = (title || data.statement.trim()).split(/\n/)[0] ?? "";
  if (firstLine.length <= 88) return firstLine;
  const words = firstLine.match(/`[^`]+`|\S+/g) ?? [];
  let heading = "";
  for (const word of words) {
    if (heading.length + word.length + 1 > 85) break;
    heading += `${heading ? " " : ""}${word}`;
  }
  return heading ? `${heading}…` : "Decision";
}

function elementHeading(element: HostElement): string | undefined {
  switch (element.kind) {
    case "section":
    case "order_step":
      return element.data.title;
    case "decision":
      return decisionHeading(element.data);
    case "requirement":
      return element.data.name;
    case "finding":
      return element.data.concern.split(/\n/)[0]?.replace(/^#{1,6}\s+/, "");
    default:
      return undefined;
  }
}

function elementText(element: HostElement): string | undefined {
  switch (element.kind) {
    case "prose":
      return element.data.markdown;
    case "callout":
    case "annotation":
      return element.data.body;
    case "requirement":
      return element.data.shall;
    case "decision":
      return element.data.statement;
    case "noise_verdict":
      return element.data.reason;
    default:
      return undefined;
  }
}

function childrenOf(element: HostElement): readonly string[] {
  switch (element.kind) {
    case "section":
    case "order_step":
      return element.data.children;
    case "requirement":
      return element.data.scenarios ?? [];
    default:
      return [];
  }
}

function firstParagraph(text: string, headings: ReadonlySet<string>): string | undefined {
  return text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find(
      (paragraph) =>
        paragraph.length > 0 &&
        !/^#{1,6}\s/.test(paragraph) &&
        !/^```/.test(paragraph) &&
        !/^(?:[-*_]\s*){3,}$/.test(paragraph) &&
        !headings.has(normalized(paragraph)),
    );
}

export function sectionPreview(
  section: ElementOf<"section">,
  index: ReadonlyMap<string, HostElement>,
): SectionPreview {
  const entries: SectionPreviewEntry[] = [];
  const content: SectionPreviewEntry[] = [];
  const labels = new Set([normalized(section.data.title)]);
  const seen = new Set([section.id]);
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const element = index.get(id);
      if (element === undefined) continue;
      const title = elementHeading(element)?.trim();
      if (title && !labels.has(normalized(title))) {
        labels.add(normalized(title));
        entries.push({ id, text: title });
      }
      const text = elementText(element);
      if (text !== undefined) content.push({ id, text });
      visit(childrenOf(element));
    }
  };
  visit(section.data.children);
  if (entries.length > 0) return { kind: "headings", entries };
  for (const { id, text } of content) {
    const paragraph = firstParagraph(text, labels);
    if (paragraph) return { kind: "paragraph", entry: { id, text: paragraph } };
  }
  return { kind: "empty" };
}

/** Preview labels keep inline code readable without embedding citation buttons in a link. */
export function PreviewText({ text }: { readonly text: string }) {
  return [...text.matchAll(/`[^`]+`|\*\*[^*]+\*\*|[^`*]+|[`*]/g)].map((match) => {
    const part = match[0];
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={match.index} className="font-mono text-inherit">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={match.index} className="font-medium">
          <PreviewText text={part.slice(2, -2)} />
        </strong>
      );
    }
    return <Fragment key={match.index}>{part}</Fragment>;
  });
}
