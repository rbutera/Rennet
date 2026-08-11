// @vitest-environment happy-dom
//
// The spec angle wiring (#16): mounting the real `CanvasWorkspace` with the view
// store forced to the "spec" angle renders the `OpenSpecView` over the demo
// OpenSpec change (a real change frozen from the parser), and a disposition verb
// clicked on a node reaches the workspace's `onOpenSpecDisposition` sink with a
// write keyed to that node's structural anchor. Behavioural, not presence-only.
import { describe, expect, it } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import type { DispositionWrite } from "../canvas/logic";
import { demoOpenSpecChange } from "../canvas/openspec-fixture";
import { createViewStore } from "../canvas/store";
import { fireEvent, mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

describe("CanvasWorkspace — the spec angle renders OpenSpecView", () => {
  it("renders the demo OpenSpec change when the angle is spec", () => {
    const { container } = mount(
      <CanvasWorkspace canvases={demoCanvases()} store={createViewStore({ angle: "spec" })} />,
    );
    const view = container.querySelector(".openspec-view");
    expect(view).not.toBeNull();
    expect(container.querySelector(".openspec-name")?.textContent).toBe(demoOpenSpecChange().name);
  });

  it("routes a node disposition to onOpenSpecDisposition, keyed to the structural anchor", () => {
    const writes: DispositionWrite[] = [];
    const { container } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={createViewStore({ angle: "spec" })}
        onOpenSpecDisposition={(write) => writes.push(write)}
      />,
    );
    // Approve the first capability node.
    const button = container.querySelector<HTMLButtonElement>(
      '[data-anchor="proposal:capabilities/0"] .disposition-cluster-btn[data-type="approve"]',
    );
    expect(button).not.toBeNull();
    if (button) fireEvent.click(button);
    expect(writes).toEqual([{ path: "proposal:capabilities/0", type: "approve", body: "" }]);
  });
});
