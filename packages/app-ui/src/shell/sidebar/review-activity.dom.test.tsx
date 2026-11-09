// @vitest-environment happy-dom
import type { SidebarSession } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, mount, waitFor } from "../../test/dom";
import { useReviewActivityState } from "../review-activity-state";
import { SidebarReviewActivity } from "./review-activity";

// ONE workspace project holding TWO repositories that both have a `main` (CLAUDE.md's
// "many repos to one identity" shape): the rows differ only in session id and repository.
// Activity keys on the session id, so the overlap is inert for this component — the fixture
// carries the shape so a future key on project or branch would be caught here, not in the field.
const session = (id: string, preparation?: SidebarSession["preparation"]): SidebarSession => ({
  id,
  projectId: "workspace",
  title: "main",
  target: "your-branch",
  repository: `rbutera/${id}`,
  createdAt: 0,
  reviewId: `review-${id}`,
  ...(preparation ? { preparation } : {}),
});
const reconcile = (rows: readonly SidebarSession[]) =>
  act(() => useReviewActivityState.getState().reconcile(rows));

afterEach(() => {
  cleanup();
  useReviewActivityState.setState({ bySession: {} });
});

describe("background review activity", () => {
  it("tracks overlapping branch names independently and acknowledges only the opened review", async () => {
    const r = mount(
      <>
        <SidebarReviewActivity sessionId="one" active={false} />
        <SidebarReviewActivity sessionId="two" active={false} />
      </>,
    );
    reconcile([
      session("one", { status: "capturing", step: "capturing-change" }),
      session("two", { status: "capturing", step: "capturing-change" }),
    ]);
    expect(r.getAllByRole("status", { name: "Reviewing the change" })).toHaveLength(2);
    reconcile([session("one"), session("two", { status: "capturing", step: "capturing-change" })]);
    expect(r.getAllByRole("status", { name: "Reviewing the change" })).toHaveLength(1);
    expect(r.getByRole("status", { name: "Review ready" })).toBeTruthy();
    r.rerender(
      <>
        <SidebarReviewActivity sessionId="one" active={true} />
        <SidebarReviewActivity sessionId="two" active={false} />
      </>,
    );
    await waitFor(() => expect(r.queryByRole("status", { name: "Review ready" })).toBeNull());
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
  });

  it("never calls a review ready while it waits on the large-file answer", () => {
    // capturing → awaiting attaches the review and stops for the reviewer's choice. Nothing
    // is ready: reading the attached review id as "finished" would put a check on a review
    // that has not been checked out, let alone drafted.
    const r = mount(<SidebarReviewActivity sessionId="one" active={false} />);
    reconcile([session("one", { status: "capturing", step: "capturing-change" })]);
    reconcile([
      session("one", {
        status: "awaiting",
        kind: "large-file-choice",
        lfsAvailable: false,
        reviewId: "review-one",
      }),
    ]);
    expect(r.queryByRole("status", { name: "Review ready" })).toBeNull();
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
  });

  it("reconciles post-round work after navigation and does not acknowledge a successor operation", () => {
    const r = mount(<SidebarReviewActivity sessionId="one" active={false} />);
    const row = session("one");
    reconcile([{ ...row, reviewActivity: { status: "running", operationId: "round-1" } }]);
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
    reconcile([{ ...row, reviewActivity: { status: "complete", operationId: "round-1" } }]);
    expect(r.getByRole("status", { name: "Review ready" })).toBeTruthy();
    reconcile([{ ...row, reviewActivity: { status: "running", operationId: "round-2" } }]);
    act(() => useReviewActivityState.getState().acknowledge("one"));
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
    reconcile([
      {
        ...row,
        reviewActivity: { status: "failed", operationId: "round-2", reason: "Report unavailable" },
      },
    ]);
    expect(r.getByLabelText("Review failed: Report unavailable")).toBeTruthy();
    expect(r.queryByRole("status", { name: "Review ready" })).toBeNull();
  });

  it("clears cancellation, exposes failure, and never acknowledges a newer running generation", () => {
    const r = mount(<SidebarReviewActivity sessionId="one" active={false} />);
    reconcile([session("one", { status: "capturing", step: "capturing-change" })]);
    reconcile([session("one", { status: "cancelled", stage: "capture" })]);
    expect(r.queryByRole("status")).toBeNull();
    reconcile([
      session("one", {
        status: "failed",
        stage: "capture",
        reason: "Repository unavailable",
        kind: "ref-gone",
      }),
    ]);
    expect(r.getByLabelText("Review failed: Repository unavailable")).toBeTruthy();
    reconcile([session("one", { status: "capturing", step: "capturing-change" })]);
    act(() => useReviewActivityState.getState().acknowledge("one"));
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
    expect(r.queryByLabelText("Review failed: Repository unavailable")).toBeNull();
  });

  it("says a failed preparation the way its block does, never the failing step's raw text", () => {
    // An unclassified failure's reason is whatever the failing step printed. The block leads
    // with a plain sentence and keeps that text behind Details; the sidebar's tooltip and
    // label must not read it aloud either.
    const raw = "fatal: git-lfs filter-process: git-lfs: command not found\nerror: external filter";
    const r = mount(<SidebarReviewActivity sessionId="one" active={false} />);
    reconcile([session("one", { status: "failed", stage: "workspace", reason: raw })]);
    const icon = r.getByLabelText("Review failed: Rennet couldn't prepare this review.");
    expect(icon.closest("[title]")?.getAttribute("title")).toBe(
      "Rennet couldn't prepare this review.",
    );
    expect(document.body.innerHTML).not.toContain("command not found");

    // A classified failure's reason IS the daemon's plain sentence, so it is what is said.
    reconcile([
      session("one", {
        status: "failed",
        stage: "workspace",
        reason: "Git LFS is needed to check out this pull request.",
        kind: "tool-missing",
        action: "install",
        tool: "git-lfs",
        detail: raw,
      }),
    ]);
    expect(
      r.getByLabelText("Review failed: Git LFS is needed to check out this pull request."),
    ).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("command not found");
  });
});
