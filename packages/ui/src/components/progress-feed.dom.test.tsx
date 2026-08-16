// @vitest-environment happy-dom
//
// The shared narration-feed organ (issue #71): one component renders the per-repo
// blocks for every narrated slot. These tests mount `ProgressFeed` directly over
// derived blocks and pin the anchoring contract (task 6): a landed block with an
// artifact + a wired `onAnchor` is an anchor that navigates; a block with no
// artifact — or no wired navigation — is plain text, never a dead link.
import type { ProgressArtifactRef } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { ProgressFeed } from "./progress-feed";
import type { RepoBlockView } from "./progress-feed-fold";

const landed = (overrides: Partial<RepoBlockView> = {}): RepoBlockView => ({
  repo: "orbital",
  state: "done",
  trail: [{ stage: "build", note: "Building the repo map" }],
  summary: { repo: "orbital", path: "/orbital", ok: true, files: 5, symbols: 3 },
  ...overrides,
});

describe("ProgressFeed — the shared narration organ", () => {
  it("renders the per-repo trail (the done-ledger + real counts)", () => {
    const { container } = mount(<ProgressFeed blocks={[landed()]} />);
    expect(container.querySelector(".processing-repos")).not.toBeNull();
    expect(container.querySelector(".processing-repo[data-state='done']")).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("Building the repo map");
    expect(text).toContain("5 files · 3 symbols");
  });

  it("renders nothing when there are no blocks (never a bare wall)", () => {
    const { container } = mount(<ProgressFeed blocks={[]} />);
    expect(container.querySelector(".processing-repos")).toBeNull();
  });

  it("a landed block with an artifact + onAnchor is an anchor that navigates", () => {
    const artifact: ProgressArtifactRef = { kind: "project", projectId: "p1" };
    const onAnchor = vi.fn();
    const { container, getByRole } = mount(
      <ProgressFeed blocks={[landed({ anchor: artifact })]} onAnchor={onAnchor} />,
    );
    // The name is a real, focusable control (a button), not decorative text.
    const anchor = getByRole("button", { name: "orbital" });
    expect(anchor).not.toBeNull();
    expect(container.querySelector(".processing-repo-name.is-anchor")).not.toBeNull();
    fireEvent.click(anchor);
    expect(onAnchor).toHaveBeenCalledTimes(1);
    expect(onAnchor).toHaveBeenCalledWith(artifact);
  });

  it("a block with an artifact but NO onAnchor is plain text — nothing to navigate", () => {
    const { container, queryByRole } = mount(
      <ProgressFeed blocks={[landed({ anchor: { kind: "project", projectId: "p1" } })]} />,
    );
    expect(queryByRole("button", { name: "orbital" })).toBeNull();
    expect(container.querySelector(".processing-repo-name.is-anchor")).toBeNull();
    expect(container.textContent).toContain("orbital");
  });

  it("a landed block with NO artifact is honestly inert even when onAnchor is wired", () => {
    const onAnchor = vi.fn();
    const { container, queryByRole } = mount(
      <ProgressFeed blocks={[landed()]} onAnchor={onAnchor} />,
    );
    // No artifact ⇒ no anchor control, no broken navigation on activation.
    expect(queryByRole("button", { name: "orbital" })).toBeNull();
    expect(container.querySelector(".processing-repo-name.is-anchor")).toBeNull();
    expect(onAnchor).not.toHaveBeenCalled();
  });

  it("an in-progress block never anchors, even with an artifact + onAnchor", () => {
    const onAnchor = vi.fn();
    const { queryByRole } = mount(
      <ProgressFeed
        blocks={[landed({ state: "processing", anchor: { kind: "project", projectId: "p1" } })]}
        onAnchor={onAnchor}
      />,
    );
    // Only a LANDED line anchors; a still-running one is not yet navigable.
    expect(queryByRole("button", { name: "orbital" })).toBeNull();
  });
});
