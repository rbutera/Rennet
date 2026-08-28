import { describe, expect, it } from "vitest";
import { cornerSlotOwner } from "./corner-slot";

// ─────────────────────────────────────────────────────────────────────────────
// The single-owner authority (C20 §1.2). Pure, so all four {sidebarOpen, dockOpen}
// combinations are one table. The load-bearing row is the last one: a CLOSED dock
// is still MOUNTED in this frame (width 0 + `inert`), so ownership must key on
// `dockOpen`, never on the dock existing — otherwise the slot double-mounts inside
// a hidden subtree and steals the window's drag region.
// ─────────────────────────────────────────────────────────────────────────────

describe("cornerSlotOwner (C20 §1.2)", () => {
  it("gives the slot to the leftmost live pane over all four states", () => {
    expect(cornerSlotOwner({ sidebarOpen: true, dockOpen: true })).toBe("sidebar");
    expect(cornerSlotOwner({ sidebarOpen: true, dockOpen: false })).toBe("sidebar");
    expect(cornerSlotOwner({ sidebarOpen: false, dockOpen: true })).toBe("chat");
    expect(cornerSlotOwner({ sidebarOpen: false, dockOpen: false })).toBe("floating");
  });
});
