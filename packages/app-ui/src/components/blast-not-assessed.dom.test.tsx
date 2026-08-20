// @vitest-environment happy-dom
//
// The NOT-ASSESSED chips (issue #35): the honesty-critical half of the blast-radius
// overlay. A signal that was not run must be visible AS not-run, because a reviewer
// who sees no amber and no chip would read the surface as "checked and clear". This
// mounts the real component and asserts the deferred signals are rendered as chips.
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { BlastNotAssessed } from "./lens";

describe("BlastNotAssessed chips (issue #35)", () => {
  it("renders each deferred signal as a visible chip, so unmeasured reads as unmeasured", () => {
    const { container } = mount(
      <BlastNotAssessed
        signals={[
          { signal: "fan-in", reason: "Fan-in not assessed." },
          { signal: "contract-surface", reason: "Contract surface not assessed." },
        ]}
      />,
    );
    const note = container.querySelector(".blast-not-assessed");
    expect(note).not.toBeNull();
    expect(note?.getAttribute("aria-label")).toMatch(/not assessed/i);
    const chips = container.querySelectorAll(".blast-chip");
    expect(chips).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Not assessed");
    expect(text).toContain("Fan-in");
    expect(text).toContain("Contract surface");
    // The reason rides as the chip's title (hover detail), the label stays terse.
    expect(chips[0]?.getAttribute("title")).toMatch(/not assessed/i);
  });

  it("renders nothing when every signal was assessed (no deferred signals)", () => {
    const { container } = mount(<BlastNotAssessed signals={[]} />);
    expect(container.querySelector(".blast-not-assessed")).toBeNull();
  });
});
