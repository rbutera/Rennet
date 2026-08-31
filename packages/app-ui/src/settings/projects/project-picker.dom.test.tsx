// @vitest-environment happy-dom
//
// The scope picker's KEYBOARD identity. cmdk decides which row is highlighted and which
// one Enter selects by comparing its store value to each item's `value` — so `value` is
// the row's identity, not its label. A workspace maps many repos to one identity and a
// project name is not unique across hosts (`rennet` on local and on a remote box is two
// projects, one name), which is the collision this file pins.
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarHost } from "../../shell/sidebar-data";
import { cleanup, fireEvent, mount, screen } from "../../test/dom";
import { ProjectPicker } from "./project-picker";

afterEach(cleanup);

/** Two hosts, ONE display name. The ids differ; nothing on screen says so. */
const HOSTS: readonly SidebarHost[] = [
  {
    id: "local",
    label: "This Mac",
    kind: "local",
    projects: [{ id: "p-local", name: "rennet", fallbackName: "rbutera/rennet", sessions: [] }],
  },
  {
    id: "lancelot",
    label: "lancelot",
    kind: "remote",
    projects: [{ id: "p-remote", name: "rennet", fallbackName: "rbutera/rennet", sessions: [] }],
  },
];

function openPicker(): { chosen: string[] } {
  const chosen: string[] = [];
  mount(<ProjectPicker hosts={HOSTS} value="p-local" onChange={(id) => chosen.push(id)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
  return { chosen };
}

/** cmdk marks the highlighted row `aria-selected="true"`; it is the store value's mirror. */
function rows(): HTMLElement[] {
  return screen.getAllByRole("option");
}

describe("ProjectPicker — same-named projects on different hosts stay distinct", () => {
  it("highlights exactly one row, and ArrowDown moves the highlight to the other host's", () => {
    // The defect: with `value` set to the DISPLAY NAME, both rows carried the same identity,
    // so both were `aria-selected` at once and ArrowDown had nowhere to go — cmdk set the
    // store to a value it already held and the write no-opped.
    openPicker();
    const [first, second] = rows();
    expect(rows()).toHaveLength(2);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(second?.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(screen.getByPlaceholderText("Search projects"), { key: "ArrowDown" });
    expect(first?.getAttribute("aria-selected")).toBe("false");
    expect(second?.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter after ArrowDown activates the SECOND project, not the first", () => {
    // The user-visible half: Enter used to hit whichever same-named row cmdk found first,
    // so the remote project was unreachable from the keyboard entirely.
    const { chosen } = openPicker();
    const input = screen.getByPlaceholderText("Search projects");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(chosen).toEqual(["p-remote"]);
  });

  it("still searches by the name and host the reviewer can read", () => {
    // The identity is now an id nobody types, so the searchable text moved to `keywords`.
    // Without them this filters to nothing and the picker is a blank list.
    openPicker();
    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "lancelot" },
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("rennet");
  });
});
