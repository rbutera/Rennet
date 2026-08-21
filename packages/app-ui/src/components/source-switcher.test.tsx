// @vitest-environment happy-dom
//
// The source switcher (source-aware project selection, task 6): the rows above the
// directory browser that choose which source's daemon the add-flow browses. Mounts the
// real component and asserts the rows render, a click reports the chosen source id, and
// the per-row "connecting…" state shows while the shell attaches.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, screen } from "../test/dom";
import { type SourceOption, SourceSwitcher } from "./source-switcher";

const sources: SourceOption[] = [
  { id: "local", label: "Local" },
  { id: "wsl:Ubuntu", label: "WSL: Ubuntu" },
];

describe("SourceSwitcher", () => {
  it("renders a row per source and reports the clicked id", () => {
    const onSelect = vi.fn();
    mount(
      <SourceSwitcher sources={sources} selected="local" connecting={false} onSelect={onSelect} />,
    );

    expect(screen.getByRole("button", { name: /Local/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /WSL: Ubuntu/ }));
    expect(onSelect).toHaveBeenCalledWith("wsl:Ubuntu");
  });

  it("keeps Local first even when passed last", () => {
    const reordered: SourceOption[] = [
      { id: "wsl:Ubuntu", label: "WSL: Ubuntu" },
      { id: "local", label: "Local" },
    ];
    mount(
      <SourceSwitcher sources={reordered} selected="local" connecting={false} onSelect={vi.fn()} />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows[0]?.textContent).toContain("Local");
  });

  it("shows a connecting state on the selected row while attaching", () => {
    const { container } = mount(
      <SourceSwitcher sources={sources} selected="wsl:Ubuntu" connecting onSelect={vi.fn()} />,
    );
    const connectingRow = container.querySelector(".source-connecting");
    expect(connectingRow?.textContent).toContain("connecting");
    // the connecting note rides the SELECTED row, not the local one
    expect(screen.getByRole("button", { name: /WSL: Ubuntu/ }).textContent).toContain("connecting");
    expect(screen.getByRole("button", { name: /Local/ }).textContent).not.toContain("connecting");
  });
});
