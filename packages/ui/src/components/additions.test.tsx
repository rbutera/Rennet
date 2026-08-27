// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { Collapse } from "./collapse";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { Kbd } from "./kbd";
import { Progress } from "./progress";
import { ResizeHandle } from "./resizable";
import { Toggle } from "./toggle";
import { ToggleGroup } from "./toggle-group";

// happy-dom doesn't implement pointer capture; the resize handle calls it.
beforeAll(() => {
  const proto = Element.prototype as unknown as {
    setPointerCapture?: () => void;
    releasePointerCapture?: () => void;
  };
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
});

test("context-menu opens on contextmenu and an item fires its handler", async () => {
  let hits = 0;
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div>row</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => hits++}>Rename</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("row"));
  const item = await screen.findByText("Rename");
  await userEvent.click(item);
  expect(hits).toBe(1);
});

test('toggle-group toggles selection and deselect yields [] not the "" sentinel', async () => {
  let last: readonly string[] | undefined;
  render(
    <ToggleGroup defaultValue={["approve"]} onValueChange={(v) => (last = v)}>
      <Toggle value="approve">Approve</Toggle>
      <Toggle value="revise">Revise</Toggle>
    </ToggleGroup>,
  );
  const approve = screen.getByRole("button", { name: "Approve" });
  // Starts pressed (defaultValue), deselecting it must produce an empty ARRAY.
  expect(approve.getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(approve);
  expect(Array.isArray(last)).toBe(true);
  expect(last).toEqual([]);
  // The S6 sin: "no selection" must never be the empty string.
  expect(last).not.toBe("");
  expect(screen.getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
});

test("kbd renders its content inside a <kbd>", () => {
  render(<Kbd>⌘K</Kbd>);
  const el = screen.getByText("⌘K");
  expect(el.tagName).toBe("KBD");
});

test("progress exposes aria-valuenow for a value", () => {
  render(<Progress value={42} max={100} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
});

// ── The packet's named proof for collapse ────────────────────────────────────
// Content stays MOUNTED when closed, and the wrapper carries `inert` so the
// closed content leaves the tab order. Positive control: dropping `inert={!open}`
// from collapse.tsx makes the "inert when closed" assertions fail (verified once
// by hand during authoring, then reverted).
test("collapse keeps content mounted and tab-order inert when closed", () => {
  const { container, rerender } = render(
    <Collapse open>
      <button type="button">Focusable</button>
    </Collapse>,
  );
  const wrapper = () => container.querySelector('[data-slot="collapse"] > div') as HTMLElement;

  // Open: child present, wrapper NOT inert.
  expect(screen.getByRole("button", { name: "Focusable" })).toBeTruthy();
  expect(wrapper().hasAttribute("inert")).toBe(false);

  // Closed: child STILL in the document (mounted), wrapper IS inert.
  rerender(
    <Collapse open={false}>
      <button type="button">Focusable</button>
    </Collapse>,
  );
  expect(screen.getByRole("button", { name: "Focusable" })).toBeTruthy();
  expect(wrapper().hasAttribute("inert")).toBe(true);

  // Reopen: inert gone again.
  rerender(
    <Collapse open>
      <button type="button">Focusable</button>
    </Collapse>,
  );
  expect(wrapper().hasAttribute("inert")).toBe(false);
});

test("resizable clamps a pointer drag to [min, max] and resets on double-click", () => {
  const calls: number[] = [];
  render(
    <ResizeHandle
      value={400}
      min={200}
      max={600}
      defaultValue={420}
      aria-label="Resize column"
      onChange={(v) => calls.push(v)}
    />,
  );
  const handle = screen.getByRole("separator", { name: "Resize column" });
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");

  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
  // Drag far right: 400 + (1000-100) = 1300, clamped to max 600.
  fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 });
  expect(calls.at(-1)).toBe(600);
  // Drag far left: 400 + (-500-100) = -200, clamped to min 200.
  fireEvent.pointerMove(handle, { clientX: -500, pointerId: 1 });
  expect(calls.at(-1)).toBe(200);
  fireEvent.pointerUp(handle, { clientX: -500, pointerId: 1 });

  fireEvent.doubleClick(handle);
  expect(calls.at(-1)).toBe(420);

  // Keyboard-operable splitter: arrows nudge by step (16), Home/End hit bounds.
  expect(handle.getAttribute("aria-valuenow")).toBe("400");
  expect(handle.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(calls.at(-1)).toBe(416);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(calls.at(-1)).toBe(384);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(calls.at(-1)).toBe(200);
  fireEvent.keyDown(handle, { key: "End" });
  expect(calls.at(-1)).toBe(600);
});
