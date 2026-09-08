// @vitest-environment happy-dom
//
// The work-branch line (workspace-settings D4, task 2.7).
//
// Two claims are being held here and they fail differently. The LINE is a claim about the
// reviewer's repository — which branch moved, which did not, and how far the remote is
// ahead of them — and it must not be true only sometimes. The ACTION is a claim about what
// a click does, and about what happens when git says no: the refusal is shown as git wrote
// it, and the button is still there afterwards.
//
// Every sentence now comes from `session.workBranchState`, a read of REFS, which is the
// review finding this file was rewritten for: the old line came from a `workBranchPushed`
// flag stamped once by a push, so it went on saying "behind its upstream" after a landing
// had made that false. The states below are therefore states of the repository, not props.
import type { CommandOutput } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { WorkBranchNote } from "./work-branch-note";

/** One work-branch state, served as the daemon would serve it. */
function stateOf(state: CommandOutput<"session.workBranchState">): MemoryBridgeHandlers {
  return { "session.workBranchState": async () => state };
}

function render(handlers: MemoryBridgeHandlers) {
  const bridge = new MemoryBridge(handlers);
  return mount(
    <BridgeProvider bridge={bridge}>
      <WorkBranchNote sessionId="s1" />
    </BridgeProvider>,
  );
}

const ON_SIBLING = {
  branch: "feat/x",
  workBranch: "rennet/feat/x",
  aheadOfBranch: 1,
  behindRemote: 0,
  pushed: false,
  landed: false,
};

const line = (container: Element | Document) =>
  container.querySelector('[data-testid="round-work-branch"]');

describe("WorkBranchNote", () => {
  it("names the REMOTE-TRACKING REF and the count after a push, not 'its upstream'", async () => {
    const { container } = render(
      stateOf({
        ...ON_SIBLING,
        // THE TWO COUNTS DISAGREE, which is the whole point of the pair: the sibling holds
        // one commit `feat/x` does not, and `origin/feat/x` holds two — a teammate pushed
        // as well. The sentence is about the REMOTE, so it must say two. Rendering
        // `aheadOfBranch` here (the old single `ahead`) prints "by 1".
        aheadOfBranch: 1,
        behindRemote: 2,
        pushed: true,
        remoteRef: "refs/remotes/origin/feat/x",
      }),
    );
    await waitFor(() => {
      expect(line(container)?.textContent).toContain("feat/x is behind origin/feat/x by 2 commits");
    });
    // The no-self-explaining-chrome rule, executed rather than asserted about. The BRANCH
    // and REF names are removed first — `origin/feat/x` is a ref the reviewer can `git log`,
    // not Rennet explaining itself — and what remains must name no machinery at all, and
    // must not fall back on "upstream", which is a concept rather than a ref.
    const prose = (line(container)?.textContent ?? "")
      .split("origin/feat/x")
      .join("")
      .split("rennet/feat/x")
      .join("")
      .split("feat/x")
      .join("")
      .toLowerCase();
    for (const machinery of [
      "rennet",
      "worktree",
      "workspace",
      "bound",
      "setting",
      "session",
      "upstream",
    ]) {
      expect(prose).not.toContain(machinery);
    }
  });

  it("does NOT claim a remote ref is behind before a push has happened", async () => {
    // The claim is about the REMOTE, and only a real push makes it true. Before one, the
    // honest sentence is the local one: the commits are on the sibling, the branch has not
    // moved. This is the pair that keeps the line above from being boilerplate.
    const { container } = render(stateOf(ON_SIBLING));
    await waitFor(() => {
      expect(line(container)?.textContent).toContain("The round's commits are on");
    });
    expect(line(container)?.textContent).toContain("feat/x has not moved");
    expect(line(container)?.textContent).not.toContain("behind");
  });

  it("renders NOTHING when the work is on the reviewed branch itself", async () => {
    // Every session under `share`. A line saying "the commits are on feat/x, feat/x has not
    // moved" would be a contradiction on the card of every ordinary round.
    const { container } = render(
      stateOf({
        branch: "feat/x",
        workBranch: "feat/x",
        aheadOfBranch: 0,
        behindRemote: 0,
        pushed: false,
        landed: false,
      }),
    );
    await waitFor(() => {
      expect(line(container)).toBeNull();
    });
  });

  it("renders NOTHING once the branch is AT the work branch's tip", async () => {
    // THE REVIEW FINDING, PINNED. The old flag could not express this: a session that had
    // pushed carried `workBranchPushed: true` for good, so the card kept saying the branch
    // was behind after the reviewer landed or pulled it. `landed` is a ref comparison, and
    // when it holds there is nothing left to say.
    const { container } = render(
      stateOf({
        ...ON_SIBLING,
        aheadOfBranch: 0,
        behindRemote: 0,
        pushed: true,
        landed: true,
        remoteRef: "refs/remotes/origin/feat/x",
      }),
    );
    await waitFor(() => {
      expect(line(container)).toBeNull();
    });
  });

  it("lands on a click, addressing the session and reporting where the branch went", async () => {
    const land = vi.fn(async () => ({
      status: "landed" as const,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      headOid: "0123456789abcdef0123456789abcdef01234567",
    }));
    const { container, user } = render({
      ...stateOf(ON_SIBLING),
      "session.landWorkBranch": land,
    });

    // Nothing has run before the click — the card is not a side effect of rendering.
    expect(land).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="land-work-branch"]')).not.toBeNull();
    });
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
    const { container, user } = render({
      ...stateOf(ON_SIBLING),
      "session.landWorkBranch": async () => ({
        status: "refused" as const,
        branch: "feat/x",
        workBranch: "rennet/feat/x",
        reason: refusal,
      }),
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="land-work-branch"]')).not.toBeNull();
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
