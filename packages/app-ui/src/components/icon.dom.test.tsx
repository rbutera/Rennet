// @vitest-environment happy-dom
//
// The Icon wrapper carries Rennet's line-icon identity: lucide-react ships at a
// 2px stroke, but the product weight is ~1.6px (root DESIGN.md). If this default
// regresses to 2px the whole icon set thickens silently, so guard it here.
import { Check } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "./icon";

describe("Icon wrapper", () => {
  it("renders lucide glyphs at the 1.6px product stroke", () => {
    const html = renderToStaticMarkup(<Icon icon={Check} className="size-4" />);
    expect(html).toContain('stroke-width="1.6"');
    expect(html).toContain("size-4");
  });

  it("is decorative (aria-hidden) by default, overridable", () => {
    expect(renderToStaticMarkup(<Icon icon={Check} />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(
      <Icon icon={Check} aria-hidden={false} aria-label="done" />,
    );
    expect(labelled).not.toContain('aria-hidden="true"');
    expect(labelled).toContain('aria-label="done"');
  });

  it("lets callers override the stroke weight", () => {
    expect(renderToStaticMarkup(<Icon icon={Check} strokeWidth={2.2} />)).toContain(
      'stroke-width="2.2"',
    );
  });
});
