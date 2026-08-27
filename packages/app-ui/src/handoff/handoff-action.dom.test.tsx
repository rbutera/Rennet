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
