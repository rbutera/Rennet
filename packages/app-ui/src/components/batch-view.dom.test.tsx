// @vitest-environment happy-dom
//
// BatchView: the STAGED payload view (issue #17). Mounted-DOM coverage for the
// per-entry type Select — the kit Base UI Select must open and route a chosen
// disposition type back through `onEditType(path, type)`, the byte-for-byte edit
// the publish/handoff payload serialises. Presence tests miss a dead callback; this
// drives the control and asserts the recorded call.
import type { DispositionType } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { DispositionBatch } from "../canvas/authoring";
import { mount, waitFor } from "../test/dom";
import { BatchView } from "./batch-view";

function batch(type: DispositionType = "comment"): DispositionBatch {
  return [{ path: "src/app.ts", type, raw: "a raw note" }];
}

describe("BatchView — the staged payload", () => {
  it("routes a chosen disposition type back through onEditType", async () => {
    const onEditType = vi.fn();
    const { container, findByRole, user } = mount(
      <BatchView batch={batch("comment")} onEditType={onEditType} />,
    );
    // Open the per-entry type Select and pick a different type.
    await user.click(container.querySelector(".batch-entry-type") as HTMLElement);
    await user.click(await findByRole("option", { name: "approve" }));
    await waitFor(() => expect(onEditType).toHaveBeenCalledWith("src/app.ts", "approve"));
  });
});
