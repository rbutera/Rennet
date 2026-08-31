// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { Collapse } from "./collapse";
import { Command, CommandInput, CommandItem, CommandList } from "./command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group";
import { Kbd } from "./kbd";
import { Progress } from "./progress";
import { ResizeHandle } from "./resizable";
import { Switch } from "./switch";
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
// Children are mounted only WHILE VISIBLE, and the mount straddles the animation in
// both directions. This replaces the earlier "content stays mounted when closed"
// proof, which pinned the behaviour the perf audit (§5 H2) named as the #1 node-count
// driver on a ~700-claim board: a folded board freed nothing.
//
// happy-dom runs no CSS transitions and fires no `transitionend`, so the unmount is
// driven by a timeout matching the `duration-200` class rather than by the event. What
// these tests prove is the TIMEOUT path — that the children survive the close window and
// leave after it. What they cannot prove is that 200ms is still the CSS duration; that
// pairing lives in the class string and is checked by eye. The transition classes are
// asserted below so at least a change to the duration is visible in this file's diff.
test("collapse mounts its children only while they are visible", () => {
  vi.useFakeTimers();
  try {
    const { container, rerender } = render(
      <Collapse open>
        <button type="button">Focusable</button>
      </Collapse>,
    );
    const track = () => container.querySelector('[data-slot="collapse"]') as HTMLElement;
    const wrapper = () => container.querySelector('[data-slot="collapse"] > div') as HTMLElement;
    const child = () => container.querySelector("button");

    // Open: child present, wrapper NOT inert, row track full.
    expect(child()).toBeTruthy();
    expect(wrapper().hasAttribute("inert")).toBe(false);
    expect(track().className).toContain("grid-rows-[1fr]");
    expect(track().className).toContain("transition-[grid-template-rows] duration-200");

    // Closing: the track collapses immediately, but the children stay for the animation —
    // a close that snapped to an empty box would animate over nothing.
    rerender(
      <Collapse open={false}>
        <button type="button">Focusable</button>
      </Collapse>,
    );
    expect(child()).toBeTruthy();
    expect(wrapper().hasAttribute("inert")).toBe(true);
    expect(track().className).toContain("grid-rows-[0fr]");
    act(() => vi.advanceTimersByTime(199));
    expect(child()).toBeTruthy();

    // Closed: the animation is over and the children are GONE.
    act(() => vi.advanceTimersByTime(1));
    expect(child()).toBeNull();

    // Reopening mounts in the SAME commit that opens the track, so the animation has real
    // content to measure from its first frame.
    rerender(
      <Collapse open>
        <button type="button">Focusable</button>
      </Collapse>,
    );
    expect(child()).toBeTruthy();
    expect(track().className).toContain("grid-rows-[1fr]");
    expect(wrapper().hasAttribute("inert")).toBe(false);
    // …and a close timer left over from the fold it interrupted never drops it later.
    // (Weak assertion, named as such: the mount is re-derived during render, so several
    // wrong implementations also survive this. It is a regression guard, not a control.)
    act(() => vi.advanceTimersByTime(1_000));
    expect(child()).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
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

  // Keyboard-operable splitter: Left/Right nudge by step (16), Home/End hit bounds.
  // (Up/Down are deliberately NOT bound — they scroll the page; W3C uses Left/Right.)
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
  // Up/Down do nothing (no page-scroll hijack).
  const beforeArrows = calls.length;
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(calls.length).toBe(beforeArrows);
});

test("resizable moves value 1:1 within range, ignoring a second pointer and non-primary buttons", () => {
  const calls: number[] = [];
  render(
    <ResizeHandle
      value={400}
      min={200}
      max={600}
      aria-label="Col"
      onChange={(v) => calls.push(v)}
    />,
  );
  const handle = screen.getByRole("separator", { name: "Col" });
  // touch-action:none so a touch drag doesn't scroll the page.
  expect((handle as HTMLElement).style.touchAction).toBe("none");

  // A non-primary button must NOT start a drag.
  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1, button: 2 });
  fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
  expect(calls).toHaveLength(0);

  // Primary drag: a +50px move within range moves the value by exactly 50 (1:1).
  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
  expect(calls.at(-1)).toBe(450);

  // A second, different pointer's move is ignored — only the captured pointer drags.
  const before = calls.length;
  fireEvent.pointerMove(handle, { clientX: 999, pointerId: 2 });
  expect(calls.length).toBe(before);
  fireEvent.pointerUp(handle, { clientX: 150, pointerId: 1 });
});

test("resizable RESTORES prior body styles on pointercancel, lostpointercapture and unmount", () => {
  // Seed a prior inline body style; termination must RESTORE it, not blank it to "".
  document.body.style.cursor = "wait";
  const { unmount } = render(
    <ResizeHandle value={300} min={0} max={600} aria-label="C" onChange={() => undefined} />,
  );
  const handle = screen.getByRole("separator", { name: "C" });

  // pointercancel ends the drag and restores the saved cursor.
  fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1, button: 0 });
  expect(document.body.style.cursor).toBe("col-resize");
  fireEvent.pointerCancel(handle, { clientX: 0, pointerId: 1 });
  expect(document.body.style.cursor).toBe("wait");

  // lostpointercapture ends it too (e.g. the browser stole capture).
  fireEvent.pointerDown(handle, { clientX: 0, pointerId: 2, button: 0 });
  expect(document.body.style.cursor).toBe("col-resize");
  fireEvent.lostPointerCapture(handle, { pointerId: 2 });
  expect(document.body.style.cursor).toBe("wait");

  // Unmounting mid-drag restores the saved cursor via effect cleanup.
  fireEvent.pointerDown(handle, { clientX: 0, pointerId: 3, button: 0 });
  expect(document.body.style.cursor).toBe("col-resize");
  unmount();
  expect(document.body.style.cursor).toBe("wait");
  document.body.style.cursor = "";
});

test("toggle-group applies the vertical class against Base UI's data-orientation (not data-vertical)", () => {
  const { container } = render(
    <ToggleGroup orientation="vertical" defaultValue={["a"]}>
      <Toggle value="a">A</Toggle>
    </ToggleGroup>,
  );
  const group = container.querySelector('[data-slot="toggle-group"]') as HTMLElement;
  // Base UI 1.7 emits data-orientation="vertical"; the class selector must target THAT.
  expect(group.getAttribute("data-orientation")).toBe("vertical");
  expect(group.className).toContain("data-[orientation=vertical]:flex-col");
  expect(group.className).not.toContain("data-vertical:flex-col");
});

// ── Why CommandItem styles on `data-[selected=true]`, not `data-selected` ─────
// cmdk stamps `data-selected` on EVERY row — "false" on the ones that are not
// highlighted — so a presence-matching Tailwind variant (`data-selected:bg-muted`,
// which the upstream template uses) lights the whole list at once. This pins the
// attribute's real shape, and pins the class to the equality form.
//
// What it cannot catch: whether the styles those variants carry are the right ones.
// It proves the SELECTOR, not the paint.
test("cmdk marks unselected rows data-selected='false', so only the =true form may be styled", () => {
  render(
    <Command>
      <CommandList>
        <CommandItem value="alpha">Alpha</CommandItem>
        <CommandItem value="beta">Beta</CommandItem>
      </CommandList>
    </Command>,
  );
  const rows = screen.getAllByRole("option");
  expect(rows).toHaveLength(2);
  // cmdk highlights the first row on mount; the second is NOT highlighted — and still
  // carries the attribute. Presence-matching would style both.
  expect(rows[0]?.getAttribute("data-selected")).toBe("true");
  expect(rows[1]?.getAttribute("data-selected")).toBe("false");
  for (const row of rows) {
    expect(row.className).toContain("data-[selected=true]:bg-muted");
    // The bare presence form must not appear (it would be a superset of the above).
    expect(row.className).not.toMatch(/(?:^|\s|:)data-selected:/);
  }
});

test("an input-group addon focuses the control, and yields to a button inside it", async () => {
  let hits = 0;
  render(
    <InputGroup>
      <InputGroupInput aria-label="Address" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => hits++}>Clear</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>,
  );
  const input = screen.getByLabelText("Address");
  const addon = document.querySelector('[data-slot="input-group-addon"]') as HTMLElement;

  // Clicking the addon's own padding is a focus shorthand for the control.
  fireEvent.click(addon, { target: addon });
  expect(document.activeElement).toBe(input);

  // Clicking the button inside it runs the button — it does not get eaten by the focus hop.
  input.blur();
  const clear = screen.getByRole("button", { name: "Clear" });
  await userEvent.click(clear);
  expect(hits).toBe(1);
  // `hits === 1` alone passes with the guard DELETED — the button's own handler runs
  // either way; what the guard buys is that focus stays on the button instead of being
  // yanked to the control by the addon's bubbled handler. That is the assertion.
  expect(document.activeElement).toBe(clear);
});

// The command pill's focus ring is drawn by the GROUP, for one NAMED slot, and the
// input's own outline is off — so if the input's slot and the group's ring selector
// ever disagree, keyboard focus is invisible (DESIGN.md's focus rule). happy-dom has
// no cascade to observe, so the proof is the join: read the slot the ring selector
// actually names, then assert the element Tab lands on carries exactly that slot.
// Renaming either side reddens this.
test("the command input carries the very slot the input-group ring selector names", async () => {
  const { container } = render(
    <>
      {/* This suite does not auto-clean between tests, so a bare Tab would walk the
       *  EARLIER tests' still-mounted trees. Seeding from a button in this tree makes
       *  the traversal land here regardless of what is left over. */}
      <button type="button">before the palette</button>
      <Command>
        <CommandInput aria-label="Search commands" />
        <CommandList>
          <CommandItem value="alpha">Alpha</CommandItem>
        </CommandList>
      </Command>
    </>,
  );
  const group = container.querySelector('[data-slot="input-group"]') as HTMLElement;
  const ringSlot = /has-\[\[data-slot=([a-z-]+)\]:focus-visible\]:ring-3/.exec(
    group.className,
  )?.[1];
  expect(ringSlot).toBe("input-group-control");

  (container.querySelector("button") as HTMLElement).focus();
  await userEvent.tab();
  const focused = document.activeElement as HTMLElement;
  expect(focused).toBe(container.querySelector("[cmdk-input]"));
  expect(focused.getAttribute("aria-label")).toBe("Search commands");
  expect(focused.getAttribute("data-slot")).toBe(ringSlot);
});

test("toggle and toggle-group honor a FUNCTION-form className (cn/clsx would drop it)", () => {
  render(
    <Toggle value="x" className={() => "fn-sentinel-toggle"}>
      X
    </Toggle>,
  );
  expect(screen.getByRole("button", { name: "X" }).classList.contains("fn-sentinel-toggle")).toBe(
    true,
  );

  const { container } = render(
    <ToggleGroup className={() => "fn-sentinel-group"} defaultValue={["a"]}>
      <Toggle value="a">A</Toggle>
    </ToggleGroup>,
  );
  const group = container.querySelector('[data-slot="toggle-group"]') as HTMLElement;
  expect(group.classList.contains("fn-sentinel-group")).toBe(true);
});

test("switch sm is the 28x16 settings proportion, with the thumb size unchanged", () => {
  // The settings rows' switch. It rendered 24x14 against the design's 28x16, which beside
  // a 28px-wide row control read as a different component. The THUMB is the invariant:
  // widening the track must not fatten the knob, so both are asserted together.
  const { container } = render(<Switch size="sm" aria-label="Include" />);
  const track = container.querySelector('[data-slot="switch"]') as HTMLElement;
  const thumb = container.querySelector('[data-slot="switch-thumb"]') as HTMLElement;

  expect(track.className).toContain("data-[size=sm]:w-7");
  expect(track.className).toContain("data-[size=sm]:h-4");
  expect(track.className).not.toContain("data-[size=sm]:w-[24px]");
  expect(thumb.className).toContain("group-data-[size=sm]/switch:size-3");

  // The checked travel has to follow the track, or the knob overruns or stops short: the
  // 28px track less its 1px transparent border each side, less the 12px thumb, is 14px.
  expect(thumb.className).toContain("group-data-[size=sm]/switch:data-checked:translate-x-3.5");
});
