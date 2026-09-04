// @vitest-environment happy-dom
//
// The session trail's workspace (session-bound-workspace 5.1). A session binds to ONE
// workspace and every turn it spawns runs there — and for an off-branch or pull-request
// review that workspace is a worktree, not the reviewer's own tree. Nothing else on the
// surface says which tree a seat read, so the trail has to.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "../test/dom";
import { Trail } from "./trail";

afterEach(cleanup);

const WORKSPACE = "/Users/dev/.rennet/worktrees/-Users-dev-acme/feat-seam";

describe("Trail workspace", () => {
  it("names the bound workspace beside the branch, in full, on hover too", () => {
    const { container } = mount(
      <Trail title="feat/seam" projectName="acme" target="your-branch" workspace={WORKSPACE} />,
    );
    const slot = container.querySelector<HTMLElement>("[data-slot='trail-workspace']");
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe(WORKSPACE);
    // `truncate` clips a long path, so the untruncated value has to survive somewhere the
    // reviewer can actually read it.
    expect(slot?.getAttribute("title")).toBe(WORKSPACE);
    // The branch is still the headline; the workspace is beside it, not instead of it.
    expect(container.textContent).toContain("feat/seam");
  });

  it("says nothing when nothing is bound", () => {
    const { container } = mount(
      <Trail title="feat/seam" projectName="acme" target="your-branch" />,
    );
    expect(container.querySelector("[data-slot='trail-workspace']")).toBeNull();
  });
});
