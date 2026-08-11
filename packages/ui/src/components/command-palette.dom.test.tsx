// @vitest-environment happy-dom
//
// The ⌘K command palette (wireframes screen 16). This mounts the real overlay over
// a set of spy commands and drives the whole interaction — it opens, filters as you
// type, runs the selected command (asserting the WRAPPED action actually fired), and
// closes on Escape / click-out. The run assertions are behavioural (the spy was
// called), never a presence check.
import { describe, expect, it, vi } from "vitest";
import type { Command } from "../command/commands";
import { mount } from "../test/dom";
import { CommandPalette } from "./command-palette";

function commands(): { list: Command[]; ran: Record<string, ReturnType<typeof vi.fn>> } {
  const ran = {
    files: vi.fn(),
    canvases: vi.fn(),
    flagged: vi.fn(),
  };
  const list: Command[] = [
    { id: "nav.files", title: "Show Files view", group: "Navigate", run: ran.files },
    { id: "nav.canvases", title: "Show Canvases view", group: "Navigate", run: ran.canvases },
    { id: "lens.flagged", title: "Go to Flagged lens", group: "Lens", run: ran.flagged },
  ];
  return { list, ran };
}

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    const { list } = commands();
    const { container } = mount(<CommandPalette open={false} commands={list} onClose={vi.fn()} />);
    expect(container.querySelector(".command-palette")).toBeNull();
  });

  it("lists every command when open, then filters as the query narrows", async () => {
    const { list } = commands();
    const { user, container, getByLabelText } = mount(
      <CommandPalette open={true} commands={list} onClose={vi.fn()} />,
    );
    expect(container.querySelectorAll(".command-palette-row").length).toBe(3);

    await user.type(getByLabelText("Search commands"), "flag");
    const rows = [...container.querySelectorAll(".command-palette-row")];
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toMatch(/Flagged/);
  });

  it("runs the filtered command on Enter and then closes", async () => {
    const { list, ran } = commands();
    const onClose = vi.fn();
    const { user, getByLabelText } = mount(
      <CommandPalette open={true} commands={list} onClose={onClose} />,
    );
    // Narrow to the single Flagged command, then Enter runs it.
    await user.type(getByLabelText("Search commands"), "flag");
    await user.keyboard("{Enter}");
    expect(ran.flagged).toHaveBeenCalledTimes(1);
    // Only the selected command fires — no other action leaks.
    expect(ran.files).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves the selection with ArrowDown and runs that row on Enter", async () => {
    const { list, ran } = commands();
    const { user, getByLabelText } = mount(
      <CommandPalette open={true} commands={list} onClose={vi.fn()} />,
    );
    getByLabelText("Search commands").focus();
    // Row 0 is Files; one ArrowDown lands on Canvases.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(ran.canvases).toHaveBeenCalledTimes(1);
    expect(ran.files).not.toHaveBeenCalled();
  });

  it("runs a command on click", async () => {
    const { list, ran } = commands();
    const onClose = vi.fn();
    const { user, getByText } = mount(
      <CommandPalette open={true} commands={list} onClose={onClose} />,
    );
    await user.click(getByText("Show Files view"));
    expect(ran.files).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without running anything", async () => {
    const { list, ran } = commands();
    const onClose = vi.fn();
    const { user, getByLabelText } = mount(
      <CommandPalette open={true} commands={list} onClose={onClose} />,
    );
    getByLabelText("Search commands").focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ran.files).not.toHaveBeenCalled();
    expect(ran.canvases).not.toHaveBeenCalled();
  });

  it("shows an honest empty state when nothing matches", async () => {
    const { list } = commands();
    const { user, getByLabelText, container } = mount(
      <CommandPalette open={true} commands={list} onClose={vi.fn()} />,
    );
    await user.type(getByLabelText("Search commands"), "zzzznomatch");
    expect(container.querySelectorAll(".command-palette-row").length).toBe(0);
    expect(container.querySelector(".command-palette-empty")?.textContent).toMatch(/No commands/i);
  });
});
