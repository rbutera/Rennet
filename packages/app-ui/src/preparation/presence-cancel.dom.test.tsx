// @vitest-environment happy-dom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { MemoryBridge } from "../test/memory-bridge";
import { PreparationPresence, PresenceScope, usePresenceShown } from "./preparation-presence";

// ONE CANCEL ON EVERY FRAME (review-preparation-reliability D6).
//
// The presence tells the header it is on screen, so the header does not float a second
// Cancel over it. Published from a passive effect, that message could land a task AFTER the
// commit that drew both — a frame the browser can paint with two Cancels. A layout effect
// lands it inside the commit's own task, before any paint.
//
// `act()` flushes both effect kinds together and would hide the difference, and so does a
// sync-lane render (React flushes its passive effects at once), so this mounts with a bare
// root in the DEFAULT lane, outside act, and samples the DOM from a MutationObserver. Its
// callback runs as a microtask right after the task that mutated the DOM: after the commit
// and its layout effects, before the passive effects' task — the frame that could be painted.
// `FloatingCancel` stands in for the header's chip: it is exactly `usePresenceShown()`.

let root: Root | undefined;
let container: HTMLElement | undefined;
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function FloatingCancel() {
  return usePresenceShown() ? null : <button type="button" data-testid="floating-cancel" />;
}

it("never leaves a frame with the header's floating Cancel beside the presence", async () => {
  const bridge = new MemoryBridge({ "session.list": () => ({ sessions: [] }) });
  const framesWithBoth: number[] = [];
  const observer = new MutationObserver(() => {
    const presence = document.querySelector('[data-kind="preparation-presence"]') !== null;
    const floating = document.querySelector('[data-testid="floating-cancel"]') !== null;
    if (presence && floating) framesWithBoth.push(Date.now());
  });
  observer.observe(document.body, { childList: true, subtree: true });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <BridgeProvider bridge={bridge}>
      <PresenceScope>
        <FloatingCancel />
        <PreparationPresence slug="sess-waiting" />
      </PresenceScope>
    </BridgeProvider>,
  );

  const deadline = Date.now() + 3_000;
  while (document.querySelector('[data-kind="preparation-presence"]') === null) {
    if (Date.now() > deadline) throw new Error("the presence never rendered");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();

  expect(document.querySelector('[data-testid="floating-cancel"]')).toBeNull();
  expect(framesWithBoth).toEqual([]);
});
