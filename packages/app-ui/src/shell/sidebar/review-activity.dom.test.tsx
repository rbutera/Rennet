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
      session("one", { status: "failed", stage: "capture", reason: "Repository unavailable" }),
    ]);
    expect(r.getByLabelText("Review failed: Repository unavailable")).toBeTruthy();
    reconcile([session("one", { status: "capturing", step: "capturing-change" })]);
    act(() => useReviewActivityState.getState().acknowledge("one"));
    expect(r.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
    expect(r.queryByLabelText("Review failed: Repository unavailable")).toBeNull();
  });
});
