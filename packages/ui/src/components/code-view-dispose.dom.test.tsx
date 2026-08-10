// @vitest-environment happy-dom
//
// The CHUNK-HEADER disposition cluster on the CodeView (issue #109). Proof that the
// cluster is additive (absent with no `onDispose`, so existing callers and the R16
// node envelope are untouched), that it anchors to the file/chunk, and that
// disposing on the header fires the host with the chosen verb.
import type { DispositionType } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { CodeView } from "./code-view";

const diff = ["@@ -1,2 +1,3 @@", " context", "-old", "+new"].join("\n");

describe("the chunk-header cluster is additive", () => {
  it("renders NO cluster when no onDispose is given (existing callers unchanged)", () => {
    const { container } = mount(<CodeView path="src/rate/bucket.ts" diff={diff} renderAll />);
    expect(container.querySelector(".code-view-head .disposition-cluster")).toBeNull();
  });

  it("renders the four verbs on the header, anchored to the file/chunk, when onDispose is given", () => {
    const { container } = mount(
      <CodeView path="src/rate/bucket.ts" diff={diff} renderAll onDispose={() => undefined} />,
    );
    const cluster = container.querySelector(".code-view-head .disposition-cluster");
    expect(cluster).not.toBeNull();
    expect(cluster?.getAttribute("data-anchor-kind")).toBe("chunk");
    expect(cluster?.getAttribute("aria-label")).toBe("Dispose on chunk src/rate/bucket.ts");
    expect(container.querySelectorAll(".code-view-head .disposition-cluster-btn")).toHaveLength(4);
  });
});

describe("disposing on the header fires the host", () => {
  it("clicking request-change on the header disposes it on the chunk", () => {
    const disposed: DispositionType[] = [];
    const { container } = mount(
      <CodeView
        path="src/rate/bucket.ts"
        diff={diff}
        renderAll
        onDispose={(type) => disposed.push(type)}
      />,
    );
    const request = container.querySelector<HTMLButtonElement>(
      '.code-view-head .disposition-cluster-btn[data-type="request-change"]',
    );
    if (!request) throw new Error("no request-change verb on the header");
    // The load-bearing published verb carries ink on the header.
    expect(request.getAttribute("data-lane")).toBe("ink");
    fireEvent.click(request);
    expect(disposed).toEqual(["request-change"]);
  });
});
