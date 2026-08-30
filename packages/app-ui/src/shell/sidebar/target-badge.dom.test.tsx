// @vitest-environment happy-dom
//
// `TargetBadge` — the icon+text form of the unified target vocabulary (R36). The point of
// this component is that the treatments DIFFER per kind and state: the app had flattened
// every row's chip onto one bordered outline, which said "here is a target" and nothing
// about which one wants you. So these assertions are about the per-branch classes, not
// about the words (the words are covered where the New Chat rows are).
//
// Every branch is asserted to carry its OWN fill and to NOT carry a sibling's, which is
// what makes the suite fail if two branches ever collapse back onto one treatment.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "../../test/dom";
import { TargetBadge } from "./target-icon";

afterEach(cleanup);

function badge(node: HTMLElement): HTMLElement {
  const found = node.querySelector<HTMLElement>("[data-target-kind]");
  if (found === null) throw new Error("no badge rendered");
  return found;
}

describe("TargetBadge", () => {
  it("renders 'needs you' as the SOLID accent pill — the one loud treatment", () => {
    const { container } = mount(<TargetBadge kind="teammate-pr" state="needs-you" />);
    const pill = badge(container);
    expect(pill.className).toContain("bg-primary");
    expect(pill.className).toContain("text-primary-foreground");
    // Not the quiet raised fill every other row wears.
    expect(pill.className).not.toContain("bg-secondary/60");
    expect(pill.textContent).toBe("Needs you");
  });

  it("renders your own PR as the gold OUTLINE, never a fill", () => {
    const { container } = mount(<TargetBadge kind="your-pr" />);
    const pill = badge(container);
    expect(pill.className).toContain("border-primary/50");
    expect(pill.className).toContain("text-primary");
    expect(pill.className).not.toContain("bg-primary");
    expect(pill.className).not.toContain("bg-secondary/60");
    expect(pill.textContent).toBe("Your PR");
  });

  it("renders a plain branch and a plain teammate PR as the quiet raised fill", () => {
    const branch = mount(<TargetBadge kind="your-branch" />);
    expect(badge(branch.container).className).toContain("bg-secondary/60");
    expect(badge(branch.container).className).not.toContain("border-primary/50");
    cleanup();

    const teammate = mount(<TargetBadge kind="teammate-pr" />);
    expect(badge(teammate.container).className).toContain("bg-secondary/60");
    expect(badge(teammate.container).className).not.toContain("border-primary/50");
  });

  it("renders a reviewed target in the green register and a merged one as neutral", () => {
    const reviewed = mount(<TargetBadge kind="your-branch" state="reviewed" />);
    expect(badge(reviewed.container).className).toContain("bg-green-soft");
    expect(badge(reviewed.container).className).toContain("text-green");
    expect(badge(reviewed.container).textContent).toBe("Reviewed");
    cleanup();

    const merged = mount(<TargetBadge kind="your-pr" state="merged" />);
    // Merged is read-only history: no green, no accent, no fill.
    expect(badge(merged.container).className).toContain("text-muted-foreground");
    expect(badge(merged.container).className).not.toContain("bg-green-soft");
    expect(badge(merged.container).className).not.toContain("text-primary");
    expect(badge(merged.container).textContent).toBe("Merged");
  });

  it("keeps the KIND's own glyph under 'needs you' — a your-PR that needs you is still your PR", () => {
    // The spike hardcoded the incoming-PR arrow for this state because its fixture only
    // ever routed teammate PRs into it; Rennet's smart list puts your own PR there too.
    const yours = mount(<TargetBadge kind="your-pr" state="needs-you" />);
    const yoursGlyph = badge(yours.container).querySelector("svg")?.classList.value ?? "";
    cleanup();
    const theirs = mount(<TargetBadge kind="teammate-pr" state="needs-you" />);
    const theirsGlyph = badge(theirs.container).querySelector("svg")?.classList.value ?? "";
    // `toContain("lucide-git-pull-request")` alone is satisfied BY the arrow class
    // (`lucide-git-pull-request-arrow` contains it), so the regression this test names —
    // your-PR falling back to the incoming arrow — would have passed. The absence half is
    // what makes the assertion load-bearing.
    expect(yoursGlyph).toContain("lucide-git-pull-request");
    expect(yoursGlyph).not.toContain("lucide-git-pull-request-arrow");
    expect(theirsGlyph).toContain("lucide-git-pull-request-arrow");
  });

  it("sizes sm smaller than md, and both on the ramp's 10px floor", () => {
    const md = mount(<TargetBadge kind="your-branch" />);
    expect(badge(md.container).className).toContain("px-2");
    expect(badge(md.container).className).toContain("text-10");
    expect(badge(md.container).querySelector("svg")?.classList.value).toContain("size-3");
    cleanup();

    const sm = mount(<TargetBadge kind="your-branch" size="sm" />);
    expect(badge(sm.container).className).toContain("px-1.5");
    expect(badge(sm.container).className).toContain("text-10");
    expect(badge(sm.container).querySelector("svg")?.classList.value).toContain("size-2.5");
  });

  it("draws its glyph at Rennet's 1.6px line weight, not lucide's 2px", () => {
    const { container } = mount(<TargetBadge kind="your-branch" />);
    expect(badge(container).querySelector("svg")?.getAttribute("stroke-width")).toBe("1.6");
  });
});
