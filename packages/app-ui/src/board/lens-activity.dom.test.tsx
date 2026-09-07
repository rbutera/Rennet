// @vitest-environment happy-dom
import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import { useActivityOffset } from "./lens-activity";

it("moves an open activity panel below a heading that arrives after the trigger opens", async () => {
  let headingTop = 180;
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-board-heading")
        ? new DOMRect(0, headingTop, 100, 30)
        : new DOMRect(0, 20, 24, 20);
    });
  function Placement({ open }: { open: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const offset = useActivityOffset(open, trigger);
    return (
      <>
        <button ref={trigger} type="button">
          Activity
        </button>
        <output>{offset}</output>
      </>
    );
  }
  const view = mount(<Placement open={false} />);
  view.rerender(<Placement open />);
  expect(view.getByRole("status").textContent).toBe("12");
  const heading = document.createElement("h1");
  heading.dataset.boardHeading = "";
  act(() => view.container.append(heading));
  await waitFor(() => expect(view.getByRole("status").textContent).toBe("182"));
  headingTop = 220;
  act(() => heading.append("Sequence"));
  await waitFor(() => expect(view.getByRole("status").textContent).toBe("222"));
  view.rerender(<Placement open={false} />);
  bounds.mockClear();
  act(() => heading.append(" more"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(bounds).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
