// @vitest-environment happy-dom
//
// The COLLATION DRAFT CANVAS ink/blue lanes + the stage toggle + the sign-off
// roll-up (issue #109). Mounted-DOM proof that the material law is visible per
// item, that the stage toggle is WIRED to `stageItem`, and that the roll-up reads
// the ink subset — the red-provable proof, not an SSR presence check.

import { describe, expect, it } from "vitest";
import type { CollationDraft } from "../canvas/collation";
import { destinationVariant } from "../canvas/destination";
import { fireEvent, mount } from "../test/dom";
import { CollationDraftCanvas } from "./collation-draft-canvas";

const variant = destinationVariant("other-pr");

function mountCanvas(draft: CollationDraft) {
  const changes: CollationDraft[] = [];
  const result = mount(
    <CollationDraftCanvas
      draft={draft}
      variant={variant}
      onChange={(next) => changes.push(next)}
    />,
  );
  return { ...result, last: () => changes.at(-1) };
}

function itemByPath(container: HTMLElement, path: string): HTMLElement {
  const li = container.querySelector<HTMLElement>(`.collation-item[data-path="${path}"]`);
  if (!li) throw new Error(`no collation item for ${path}`);
  return li;
}

describe("the material law is rendered per item", () => {
  const draft: CollationDraft = [
    { id: "r", path: "r.ts", type: "request-change", raw: "fix" },
    { id: "a", path: "a.ts", type: "approve", raw: "" },
    { id: "c", path: "c.ts", type: "comment", raw: "note" },
    { id: "s", path: "s.ts", type: "comment", raw: "note", staged: true },
  ];

  it("marks each item's lane: request-change ink, approve blue, comment blue, staged comment ink", () => {
    const { container } = mountCanvas(draft);
    expect(itemByPath(container, "r.ts").getAttribute("data-lane")).toBe("ink");
    expect(itemByPath(container, "a.ts").getAttribute("data-lane")).toBe("blue");
    expect(itemByPath(container, "c.ts").getAttribute("data-lane")).toBe("blue");
    expect(itemByPath(container, "s.ts").getAttribute("data-lane")).toBe("ink");
  });

  it("shows a stage toggle ONLY for stageable types (comment/question), never approve/request-change", () => {
    const { container } = mountCanvas(draft);
    expect(itemByPath(container, "c.ts").querySelector(".collation-item-stage")).not.toBeNull();
    expect(itemByPath(container, "s.ts").querySelector(".collation-item-stage")).not.toBeNull();
    // Fixed lanes: no toggle — you cannot stage an approve or unstage a request-change.
    expect(itemByPath(container, "a.ts").querySelector(".collation-item-stage")).toBeNull();
    expect(itemByPath(container, "r.ts").querySelector(".collation-item-stage")).toBeNull();
  });
});

describe("the stage toggle is wired to stageItem", () => {
  it("checking a comment's toggle emits a draft with it staged (blue → ink)", () => {
    const draft: CollationDraft = [{ id: "c", path: "c.ts", type: "comment", raw: "note" }];
    const { container, last } = mountCanvas(draft);
    const box = itemByPath(container, "c.ts").querySelector<HTMLInputElement>(
      ".collation-item-stage-box",
    );
    if (!box) throw new Error("no stage box");
    expect(box.checked).toBe(false); // unstaged comment starts with the orchestrator
    fireEvent.click(box);
    expect(last()?.[0]?.staged).toBe(true);
  });
});

describe("the sign-off roll-up reads the ink subset", () => {
  it("request-changes when any request-change is present", () => {
    const { container } = mountCanvas([
      { id: "a", path: "a.ts", type: "approve", raw: "" },
      { id: "r", path: "r.ts", type: "request-change", raw: "fix" },
    ]);
    expect(container.querySelector(".collation-rollup")?.getAttribute("data-rollup")).toBe(
      "request-changes",
    );
    expect(container.querySelector(".collation-rollup-verdict")?.textContent).toBe(
      "Request changes",
    );
  });

  it("an approve-only draft rolls up to NOTHING — approve never publishes", () => {
    const { container } = mountCanvas([{ id: "a", path: "a.ts", type: "approve", raw: "" }]);
    expect(container.querySelector(".collation-rollup")?.getAttribute("data-rollup")).toBe("none");
    expect(container.querySelector(".collation-rollup-verdict")?.textContent).toBe(
      "Nothing to publish",
    );
    // And the lane split says everything stays local.
    expect(
      container.querySelector('.collation-lane-count[data-lane="ink"] strong')?.textContent,
    ).toBe("0");
    expect(
      container.querySelector('.collation-lane-count[data-lane="blue"] strong')?.textContent,
    ).toBe("1");
  });

  it("a staged comment with no request-change rolls up to comments", () => {
    const { container } = mountCanvas([
      { id: "a", path: "a.ts", type: "approve", raw: "" },
      { id: "s", path: "s.ts", type: "comment", raw: "note", staged: true },
    ]);
    expect(container.querySelector(".collation-rollup-verdict")?.textContent).toBe("Comments");
  });
});
