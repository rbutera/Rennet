// @vitest-environment happy-dom
//
// The shared exit CTA (C08 cluster 4, R31). Load-bearing claim: disabled with no egress; on
// submit it shows the in-flight label (full contrast, a live state) until the egress resolves.
import { GitPullRequest } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "../test/dom";
import { HandoffAction } from "./handoff-action";

afterEach(cleanup);

describe("HandoffAction", () => {
  it("is disabled when no egress is wired", () => {
    const r = mount(
      <HandoffAction label="Post Review" pendingLabel="Posting review…" icon={GitPullRequest} />,
    );
    expect(r.getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(r.getByRole("button").textContent).toContain("Post Review");
  });

  it("surfaces the rejection reason and re-arms the control on a failed submit", async () => {
    const onSubmit = () =>
      Promise.reject(new Error("GitHub rejected the review: 422 Unprocessable"));
    const r = mount(
      <HandoffAction
        label="Post Review"
        pendingLabel="Posting review…"
        icon={GitPullRequest}
        onSubmit={onSubmit}
      />,
    );
    await r.user.click(r.getByRole("button"));
    // The reason is shown (honest failure), and the control is re-armed for a retry (not stuck).
    const alert = await r.findByRole("alert");
    expect(alert.textContent).toContain("GitHub rejected the review: 422 Unprocessable");
    expect(r.getByRole("button").textContent).toContain("Post Review");
    expect(r.getByRole("button").hasAttribute("disabled")).toBe(false);
  });

  it("shows a default reason when the rejection carries no message", async () => {
    const onSubmit = () => Promise.reject(new Error(""));
    const r = mount(
      <HandoffAction
        label="Post Review"
        pendingLabel="Posting review…"
        icon={GitPullRequest}
        onSubmit={onSubmit}
      />,
    );
    await r.user.click(r.getByRole("button"));
    const alert = await r.findByRole("alert");
    expect(alert.textContent).toMatch(/Nothing left the machine/);
  });

  it("shows the in-flight label while the egress is resolving", async () => {
    let release: () => void = () => undefined;
    const onSubmit = () => new Promise<void>((resolve) => (release = resolve));
    const r = mount(
      <HandoffAction
        label="Post Review"
        pendingLabel="Posting review…"
        icon={GitPullRequest}
        onSubmit={onSubmit}
      />,
    );
    await r.user.click(r.getByRole("button"));
    expect(r.getByRole("button").textContent).toContain("Posting review…");
    expect(r.getByRole("button").hasAttribute("disabled")).toBe(true);
    release();
  });
});
