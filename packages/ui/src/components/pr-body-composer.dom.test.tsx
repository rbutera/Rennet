// @vitest-environment happy-dom
//
// The PR-body composer on the collation draft canvas (issue #74, M26). Mounted-DOM
// tests that OBSERVE what the composer emits — the red-provable proof that the
// editable title/body fields and the "Draft with AI" affordance are WIRED, not just
// rendered. A field wired to nothing passes an SSR presence check and fails here.
import { describe, expect, it } from "vitest";
import type { CollationDraft } from "../canvas/collation";
import { destinationVariant } from "../canvas/destination";
import { fireEvent, mount } from "../test/dom";
import {
  CollationDraftCanvas,
  type PrDraftState,
  type PrDraftValues,
} from "./collation-draft-canvas";

const ownBranch = destinationVariant("own-branch");
const otherPr = destinationVariant("other-pr");

function draftOf(...paths: string[]): CollationDraft {
  return paths.map((path) => ({ id: path, path, type: "comment", raw: `note ${path}` }));
}

/** Mount the canvas in own-branch mode with the composer wired to captured callbacks. */
function mountComposer(
  prDraft: PrDraftValues = { title: "", body: "" },
  prDraftState?: PrDraftState,
) {
  const edits: PrDraftValues[] = [];
  const drafts: number[] = [];
  const result = mount(
    <CollationDraftCanvas
      draft={draftOf("src/a.ts")}
      variant={ownBranch}
      onChange={() => undefined}
      prDraft={prDraft}
      onPrDraftChange={(next) => edits.push(next)}
      onDraftPrBody={() => drafts.push(1)}
      prDraftState={prDraftState}
    />,
  );
  return { ...result, edits, draftCount: () => drafts.length };
}

describe("the composer renders only in own-branch composition", () => {
  it("renders the title + body fields in own-branch mode", () => {
    const { container } = mountComposer();
    expect(container.querySelector('[data-testid="pr-draft-composer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pr-draft-title"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pr-draft-body"]')).not.toBeNull();
  });

  it("does NOT render in other-PR mode (that variant refines review comments, not a PR body)", () => {
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/a.ts")}
        variant={otherPr}
        onChange={() => undefined}
        prDraft={{ title: "", body: "" }}
        onPrDraftChange={() => undefined}
        onDraftPrBody={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="pr-draft-composer"]')).toBeNull();
  });

  it("does NOT render when the host carries no prDraft (composer unwired)", () => {
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/a.ts")}
        variant={ownBranch}
        onChange={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="pr-draft-composer"]')).toBeNull();
  });
});

describe("the fields are editable and emit the human's edit", () => {
  it("typing a title emits onPrDraftChange with the new title, body preserved", () => {
    const { container, edits } = mountComposer({ title: "old", body: "the body" });
    const title = container.querySelector<HTMLInputElement>('[data-testid="pr-draft-title"]');
    if (!title) throw new Error("no title field");
    fireEvent.change(title, { target: { value: "Bound the fail-open path" } });
    expect(edits.at(-1)).toEqual({ title: "Bound the fail-open path", body: "the body" });
  });

  it("typing a body emits onPrDraftChange with the new body, title preserved", () => {
    const { container, edits } = mountComposer({ title: "the title", body: "old" });
    const body = container.querySelector<HTMLTextAreaElement>('[data-testid="pr-draft-body"]');
    if (!body) throw new Error("no body field");
    fireEvent.change(body, { target: { value: "An honest account of the change." } });
    expect(edits.at(-1)).toEqual({ title: "the title", body: "An honest account of the change." });
  });

  it("renders the current draft values into the fields (the human's edit is what shows)", () => {
    const { container } = mountComposer({ title: "My title", body: "My body" });
    const title = container.querySelector<HTMLInputElement>('[data-testid="pr-draft-title"]');
    const body = container.querySelector<HTMLTextAreaElement>('[data-testid="pr-draft-body"]');
    expect(title?.value).toBe("My title");
    expect(body?.value).toBe("My body");
  });
});

describe("the Draft-with-AI affordance", () => {
  it("clicking Draft with AI calls onDraftPrBody", () => {
    const { container, draftCount } = mountComposer();
    const btn = container.querySelector<HTMLButtonElement>(".collation-pr-draft-btn");
    if (!btn) throw new Error("no draft button");
    expect(btn.textContent).toContain("Draft with AI");
    fireEvent.click(btn);
    expect(draftCount()).toBe(1);
  });

  it("shows a drafting state and disables the button while a turn is in flight", () => {
    const { container } = mountComposer({ title: "", body: "" }, { status: "drafting" });
    const btn = container.querySelector<HTMLButtonElement>(".collation-pr-draft-btn");
    expect(btn?.disabled).toBe(true);
    expect(btn?.textContent).toContain("Drafting");
  });

  it("shows the drafted-with-model provenance honestly", () => {
    const { container } = mountComposer(
      { title: "t", body: "b" },
      { status: "drafted", model: "gpt-5.6-luna" },
    );
    const status = container.querySelector('[data-testid="pr-draft-status"]');
    expect(status?.textContent).toContain("gpt-5.6-luna");
  });

  it("states the unavailable degradation honestly (deterministic body still previews)", () => {
    const { container } = mountComposer(
      { title: "", body: "" },
      { status: "unavailable", reason: "no seat installed" },
    );
    const status = container.querySelector('[data-testid="pr-draft-status"]');
    expect(status?.getAttribute("data-status")).toBe("unavailable");
    expect(status?.textContent).toContain("falls back to your dispositions");
  });

  it("states a failed draft honestly and leaves the text untouched", () => {
    const { container } = mountComposer(
      { title: "kept", body: "kept body" },
      { status: "failed", reason: "the turn threw" },
    );
    const status = container.querySelector('[data-testid="pr-draft-status"]');
    expect(status?.getAttribute("data-status")).toBe("failed");
    // The fields still hold the human's text — a failed draft never blanks them.
    const title = container.querySelector<HTMLInputElement>('[data-testid="pr-draft-title"]');
    expect(title?.value).toBe("kept");
  });
});
