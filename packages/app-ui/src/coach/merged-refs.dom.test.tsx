// @vitest-environment happy-dom
//
// C13 fix-loop (finding 1) — useMergedRefs must clear EVERY input on unmount. React 19
// skips its own null-invoke fallback for any ref once the ref callback returns a cleanup,
// so a merged callback that only ran callback-ref cleanups left object refs pinned to a
// detached node (fab.tsx reads `fabRef.current` for exit-flight geometry) and legacy
// callback refs never received their null-invoke. These prove a live→null rerender clears
// both ref kinds.
import { useCallback } from "react";
import { describe, expect, it } from "vitest";
import { cleanup, mount, waitFor } from "../test/dom";
import { useMergedRefs } from "./registry";

/** Attaches one element to an object ref + a legacy callback ref via useMergedRefs. */
function Probe({
  show,
  objectRef,
  onNode,
}: {
  show: boolean;
  objectRef: React.MutableRefObject<HTMLDivElement | null>;
  onNode: (node: Element | null) => void;
}) {
  // A legacy callback ref: it returns NO cleanup, so React 19 would normally null-invoke
  // it on unmount — but does not, because the merged parent callback returns a cleanup.
  const legacy = useCallback((node: Element | null) => onNode(node), [onNode]);
  const merged = useMergedRefs<HTMLDivElement>(objectRef, legacy);
  return show ? <div data-testid="node" ref={merged} /> : null;
}

describe("useMergedRefs cleanup (C13 finding 1)", () => {
  it("clears the object ref AND null-invokes the legacy callback ref on unmount", async () => {
    const objectRef: React.MutableRefObject<HTMLDivElement | null> = { current: null };
    const nodes: Array<Element | null> = [];
    const onNode = (node: Element | null) => nodes.push(node);

    const { rerender } = mount(<Probe show objectRef={objectRef} onNode={onNode} />);
    // Live: object ref points at the element, legacy ref got the element.
    expect(objectRef.current).not.toBeNull();
    expect(nodes.at(-1)).not.toBeNull();

    // Unmount the element (live→null). The merged cleanup must clear both.
    rerender(<Probe show={false} objectRef={objectRef} onNode={onNode} />);
    await waitFor(() => expect(objectRef.current).toBeNull());
    // The legacy callback ref received its null-invoke through the merged cleanup.
    expect(nodes.at(-1)).toBeNull();
    cleanup();
  });
});
