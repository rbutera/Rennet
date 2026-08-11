// @vitest-environment happy-dom
//
// Mounted coverage for the impl↔test counterpart button (Rai, wireframes #7) and
// the clickable symbol tokens (#8) added to CodeView. These are interaction
// behaviours — a real click firing a callback — so they belong in the DOM harness.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { CodeView } from "./code-view";

// A tiny diff with a function-call identifier ("doThing" before "(") the tokenizer
// classifies as a `function` token, and an Uppercase `Widget` type token.
const CALL_DIFF = ["@@ -1,2 +1,2 @@", "+  doThing();", "+  const w = new Widget();"].join("\n");

// A line of ORDINARY identifiers the tokenizer classifies as `plain` — the real
// common case the class-only check missed. `count`, `result`, `value` are all plain;
// `const` is a keyword and must NOT be clickable.
const PLAIN_DIFF = ["@@ -1,1 +1,1 @@", "+  const count = result.value;"].join("\n");

describe("CodeView — impl/test counterpart button (#7)", () => {
  it("renders the given label and fires onView on click", () => {
    const onView = vi.fn();
    const { container } = mount(
      <CodeView
        path="src/foo.ts"
        diff={CALL_DIFF}
        counterpart={{ label: "View test", path: "src/foo.test.ts", onView }}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>(".code-view-counterpart");
    if (!button) throw new Error("counterpart button did not mount");
    expect(button.textContent).toBe("View test");
    fireEvent.click(button);
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it("renders no counterpart button when none is given", () => {
    const { container } = mount(<CodeView path="src/foo.ts" diff={CALL_DIFF} />);
    expect(container.querySelector(".code-view-counterpart")).toBeNull();
  });
});

describe("CodeView — clickable symbol tokens (#8)", () => {
  it("makes symbol identifiers clickable and reports the clicked name", () => {
    const onSymbolClick = vi.fn();
    const { container } = mount(
      <CodeView path="src/foo.ts" diff={CALL_DIFF} onSymbolClick={onSymbolClick} renderAll />,
    );
    const token = container.querySelector<HTMLButtonElement>('.rtok-symbol[data-symbol="doThing"]');
    if (!token) throw new Error("clickable symbol token did not mount");
    fireEvent.click(token);
    expect(onSymbolClick).toHaveBeenCalledWith("doThing");
  });

  it("leaves identifiers inert (plain spans, no buttons) when no handler is given", () => {
    const { container } = mount(<CodeView path="src/foo.ts" diff={CALL_DIFF} renderAll />);
    expect(container.querySelector(".rtok-symbol")).toBeNull();
  });

  it("makes ORDINARY (plain-classified) identifiers clickable — the real common case", () => {
    const onSymbolClick = vi.fn();
    const { container } = mount(
      <CodeView path="src/foo.ts" diff={PLAIN_DIFF} onSymbolClick={onSymbolClick} renderAll />,
    );
    // count / result / value are all `plain`, yet each must be its own clickable run.
    for (const name of ["count", "result", "value"]) {
      const token = container.querySelector<HTMLButtonElement>(
        `.rtok-symbol[data-symbol="${name}"]`,
      );
      if (!token) throw new Error(`identifier "${name}" was not clickable`);
      fireEvent.click(token);
      expect(onSymbolClick).toHaveBeenCalledWith(name);
    }
    // `const` is a keyword — it must NOT be clickable.
    expect(container.querySelector('.rtok-symbol[data-symbol="const"]')).toBeNull();
  });
});
