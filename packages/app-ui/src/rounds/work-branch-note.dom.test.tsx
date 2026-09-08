// @vitest-environment happy-dom
//
// The round card's work-branch line (workspace-settings D4, task 2.7).
//
// Two claims are being held here and they fail differently. The LINE is a claim about the
// reviewer's repository — which branch moved, which did not, and whether the remote is
// ahead of them — and it must not be true only sometimes. The ACTION is a claim about what
// a click does, and about what happens when git says no: the refusal is shown as git wrote
// it, and the button is still there afterwards.
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { WorkBranchNote } from "./work-branch-note";

function render(props: Parameters<typeof WorkBranchNote>[0], handlers: MemoryBridgeHandlers = {}) {
  const bridge = new MemoryBridge(handlers);
  return mount(
    <BridgeProvider bridge={bridge}>
      <WorkBranchNote {...props} />
    </BridgeProvider>,
  );
}

const OWN = { sessionId: "s1", branch: "feat/x", workBranch: "rennet/feat/x" } as const;

describe("WorkBranchNote", () => {
  it("says the local branch is behind its upstream after a push, naming BOTH branches", () => {
    const { container } = render({ ...OWN, pushed: true });
    const line = container.querySelector('[data-testid="round-work-branch"]');
    expect(line?.textContent).toContain("feat/x is behind its upstream");
    expect(line?.textContent).toContain("rennet/feat/x");
    // The no-self-explaining-chrome rule, executed rather than asserted about. The two
    // BRANCH NAMES are removed first — `rennet/feat/x` is a ref the reviewer can check out,
    // not Rennet explaining itself — and what remains must name no machinery at all.
    const prose = (line?.textContent ?? "")
      .split("rennet/feat/x")
      .join("")
      .split("feat/x")
      .join("")
      .toLowerCase();
    for (const machinery of ["rennet", "worktree", "workspace", "bound", "setting", "session"]) {
      expect(prose).not.toContain(machinery);
    }
  });

  it("does NOT claim an upstream is behind before a push has happened", () => {
    // The claim is about the REMOTE, and only a real push makes it true. Before one, the
    // honest sentence is the local one: the commits are on the sibling, the branch has not
    // moved. This is the pair that keeps the line above from being boilerplate.
    const { container } = render(OWN);
    const line = container.querySelector('[data-testid="round-work-branch"]');
    expect(line?.textContent).toContain("The round's commits are on");
    expect(line?.textContent).toContain("feat/x has not moved");
    expect(line?.textContent).not.toContain("upstream");
  });

  it("renders NOTHING when the work is on the reviewed branch itself", () => {
    // Every session under `share`. A line saying "the commits are on feat/x, feat/x has not
    // moved" would be a contradiction on the card of every ordinary round.
    const { container } = render({ sessionId: "s1", branch: "feat/x", workBranch: "feat/x" });
    expect(container.querySelector('[data-testid="round-work-branch"]')).toBeNull();
  });

  it("lands on a click, addressing the session and reporting where the branch went", async () => {
    const land = vi.fn(async () => ({
      status: "landed" as const,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      headOid: "0123456789abcdef0123456789abcdef01234567",
    }));
    const { container, user } = render(OWN, { "session.landWorkBranch": land });

    // Nothing has run before the click — the card is not a side effect of rendering.
    expect(land).not.toHaveBeenCalled();
    const button = container.querySelector('[data-testid="land-work-branch"]');
    expect(button?.textContent).toContain("Fast-forward feat/x");
    await user.click(button as Element);

    expect(land).toHaveBeenCalledTimes(1);
    expect(land).toHaveBeenCalledWith({ sessionId: "s1" });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="land-work-branch-outcome"]')?.textContent).toBe(
        "feat/x is at 0123456",
      );
    });
  });

  it("shows GIT'S refusal verbatim and KEEPS the action offered", async () => {
    const refusal =
      "error: Your local changes to the following files would be overwritten by merge:\n\tfeature.txt";
    const { container, user } = render(OWN, {
      "session.landWorkBranch": async () => ({
        status: "refused" as const,
        branch: "feat/x",
        workBranch: "rennet/feat/x",
        reason: refusal,
      }),
    });

    await user.click(container.querySelector('[data-testid="land-work-branch"]') as Element);

    await waitFor(() => {
      // Byte-for-byte, newline and tab included: the refusal is the instruction, and a
      // reworded one sends the reviewer looking for a file it did not name.
      expect(container.querySelector('[data-testid="land-work-branch-outcome"]')?.textContent).toBe(
        refusal,
      );
    });
    // No dialog, no disabled button, no "try again later": the reviewer commits their work
    // and clicks the same control (Rule Zero — git's refusal is a fact, not a gate).
    const button = container.querySelector('[data-testid="land-work-branch"]');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
