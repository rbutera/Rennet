// @vitest-environment happy-dom
//
// The ONE global key owner (autopsy S7): the Escape priority stack + the layer API.
// Escape resolves top-down (dialog → menu → topmost registered layer); a non-Escape key
// goes to the top live layer first; unmounting a layer restores the one beneath.
import { type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { emptySettings } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { KeyOwner, useKeyLayer } from "./key-owner";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, commandMenuOpen: false, commandMenuMode: "search", openDialogs: [] },
  }));
});

/** A layer that records the keys it is offered and reports them handled. */
function LayerProbe({
  priority,
  log,
}: {
  readonly priority: number;
  readonly log: string[];
}): ReactNode {
  useKeyLayer({
    priority,
    onKey: (event) => {
      log.push(`${priority}:${event.key}`);
      return true;
    },
  });
  return null;
}

/** Register/unregister a layer on demand, to prove the stack restores beneath. */
function Mounter({ mounted, children }: { readonly mounted: boolean; children: ReactNode }) {
  return mounted ? children : null;
}

function mountOwner(children: ReactNode) {
  const bridge = new MemoryBridge({ "settings.get": () => emptySettings() });
  const history = memoryHistory("/");
  return mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <KeyOwner>{children}</KeyOwner>
      </Router>
    </BridgeProvider>,
  );
}

/** Let the KeyOwner's mount effect (which attaches the window listeners) run. */
function EffectFlush() {
  useEffect(() => undefined, []);
  return null;
}

describe("key owner — Escape priority + layer stack", () => {
  it("Escape closes the frontmost dialog first, then the menu", () => {
    mountOwner(<EffectFlush />);
    act(() => {
      useRennetStore.getState().uiActions.setCommandMenuOpen(true);
      useRennetStore.getState().uiActions.openDialog("confirm");
    });
    expect(useRennetStore.getState().ui.openDialogs).toEqual(["confirm"]);
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);

    // First Escape → the dialog closes, the menu stays open (priority stack, not a race).
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useRennetStore.getState().ui.openDialogs).toEqual([]);
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);

    // Second Escape → the menu closes.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
  });

  it("a non-Escape key reaches only the top live layer", () => {
    const log: string[] = [];
    mountOwner(
      <>
        <LayerProbe priority={1} log={log} />
        <LayerProbe priority={2} log={log} />
      </>,
    );
    act(() => {
      fireEvent.keyDown(window, { key: "a" });
    });
    // The higher-priority layer got first refusal and consumed it; the lower never saw it.
    expect(log).toEqual(["2:a"]);
  });

  it("unmounting the top layer restores the layer beneath", () => {
    const log: string[] = [];
    const { rerender } = mountOwner(<LayerProbe priority={1} log={log} />);
    // Add a higher layer on top.
    const bridge = new MemoryBridge({ "settings.get": () => emptySettings() });
    const history = memoryHistory("/");
    const tree = (top: boolean) => (
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <KeyOwner>
            <LayerProbe priority={1} log={log} />
            <Mounter mounted={top}>
              <LayerProbe priority={2} log={log} />
            </Mounter>
          </KeyOwner>
        </Router>
      </BridgeProvider>
    );
    rerender(tree(true));
    act(() => {
      fireEvent.keyDown(window, { key: "b" });
    });
    expect(log).toEqual(["2:b"]); // top layer (pri 2) handled it

    // Unmount the top layer — the key now falls to the layer beneath.
    rerender(tree(false));
    act(() => {
      fireEvent.keyDown(window, { key: "c" });
    });
    expect(log).toEqual(["2:b", "1:c"]);
  });
});
