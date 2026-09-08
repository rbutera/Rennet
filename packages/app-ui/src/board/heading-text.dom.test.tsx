// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { HeadingText, stripHeadingMarkup } from "./heading-text";

// A heading is painted, not parsed: backticks become code, emphasis is unwrapped, and a
// leading `#` run is dropped. The sighting was a Flagged header reading
// `**Valid patterns can collapse distinct workspaces**` verbatim (2026-09-08).

describe("HeadingText", () => {
  it("paints backticks as inline code and keeps the surrounding words", () => {
    const { container } = mount(
      <h3>
        <HeadingText text="`own` mode works on a sibling branch" />
      </h3>,
    );
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("own");
    expect(container.querySelector("h3")?.textContent).toBe("own mode works on a sibling branch");
  });

  it("unwraps bold instead of rendering it, and never prints the asterisks", () => {
    const { container } = mount(
      <h3>
        <HeadingText text="**`--ff-only` does not require a clean checkout**" />
      </h3>,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("--ff-only");
    expect(container.textContent).toBe("--ff-only does not require a clean checkout");
    expect(container.textContent).not.toContain("*");
  });

  it("drops a leading heading mark and leaves lone marks alone", () => {
    const { container } = mount(<HeadingText text="## a * b with an _underscore_ file" />);
    // A `#` run is a heading mark; a lone `*` is arithmetic; single `_` is not emphasis here.
    expect(container.textContent).toBe("a * b with an _underscore_ file");
  });
});

describe("stripHeadingMarkup", () => {
  it("returns the reading of the heading with marks and bold gone, backticks kept", () => {
    expect(stripHeadingMarkup("### **Valid patterns** collapse `{repo}`")).toBe(
      "Valid patterns collapse `{repo}`",
    );
    expect(stripHeadingMarkup("plain")).toBe("plain");
  });
});
