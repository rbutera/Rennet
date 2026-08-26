// @vitest-environment happy-dom
//
// App-level COMMENT-REFINEMENT round trip (issue #19) — Rai's headline feature,
// end to end through the whole `RennetApp`. Mounts over a fake `RennetBridge` that
// answers `review.refine` with a real-shaped `refined` result, drives frame →
// draft, types a messy note, clicks Refine, and asserts BOTH the command input the
// app sent AND that the refined body rounds back onto the draft (the effective
// body the paper would post). Behavioural, never a presence check: RED-proof is
// unwiring `onRefine` (no command sent) or dropping `setRefined` (no refined body).
import type { CommandInput, CommandOutput, RennetBridge, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor, within } from "./test/dom";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

/** A recording bridge whose `review.refine` returns a fixed result. */
function refineBridge(ready: Review, result: CommandOutput<"review.refine">) {
  const calls: CommandInput<"review.refine">[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review: ready, repositoryPresent: true };
    if (name === "review.refine") {
      calls.push(input as CommandInput<"review.refine">);
      return result;
    }
    return { review: ready };
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"] }, calls };
}

/** A recording bridge whose `review.refine` returns a fixed refined comment. */
function refiningBridge(ready: Review, refined: string) {
  return refineBridge(ready, { status: "refined", refined, model: "gpt-5.6-terra" });
}

describe("RennetApp — the Refine control runs the loop end to end (#19)", () => {
  it("sends the raw note to review.refine and rounds the refined comment back onto the draft", async () => {
    const REFINED = "Re-keying breaks per-key clients; please document the migration note.";
    const { bridge, calls } = refiningBridge(review, REFINED);
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    // Load → destination chrome → stage a disposition via the Files "Mark read" path.
    const destination = () => container.querySelector(".destination-frame");
    await waitFor(() => expect(destination()).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(destination()?.getAttribute("data-staged-count")).toBe("1"));

    // Open the collation draft (the forming destination where refinement lives).
    const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
    if (!openDraft) throw new Error("the open-draft control did not render");
    fireEvent.click(openDraft);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());

    // Type a messy note into the item — the sovereign raw. An empty note is not
    // refinable, so this is what makes the Refine affordance appear.
    const item = () => container.querySelector<HTMLElement>(".collation-item");
    const body = within(item() ?? container).getByLabelText<HTMLTextAreaElement>("Body for item 1");
    fireEvent.change(body, { target: { value: "this breaks per-key clients?? add note" } });

    // Click Refine → the app sends review.refine and adopts the returned comment.
    await waitFor(() => {
      if (!item()?.querySelector(".collation-refine"))
        throw new Error("Refine control not offered");
    });
    fireEvent.click(within(item() ?? container).getByLabelText("Refine item 1"));

    // The command carried the raw note the user typed, verbatim, with its type.
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    if (!call) throw new Error("review.refine was not invoked");
    expect(call.reviewId).toBe("review");
    expect(call.raw).toBe("this breaks per-key clients?? add note");
    expect(call.type).toBe("comment");
    expect(typeof call.itemId).toBe("string");

    // The refined comment rounds back onto the draft — the effective body the paper
    // would post. The raw textarea still holds the sovereign note (it is an offer).
    await waitFor(() => {
      expect(item()?.querySelector(".collation-refined-body")?.textContent).toBe(REFINED);
    });
    expect(
      within(item() ?? container).getByLabelText<HTMLTextAreaElement>("Body for item 1").value,
    ).toBe("this breaks per-key clients?? add note");
  });

  it("clears a stale no-change verdict (and restores Refine) when the note is edited afterwards (#19 invalidation)", async () => {
    // The ephemeral sibling of #236: a no-change/failed/unavailable verdict must not
    // linger over text that has since changed — and because the message renders
    // ahead of the Refine button, a lingering verdict also hides the button. This
    // proves the app clears refineStates on a raw edit. RED-proof: revert app.tsx's
    // `onChange={handleDraftChange}` to `onChange={setDraft}` and this test reddens.
    const { bridge } = refineBridge(review, { status: "no-change", model: "gpt-5.6-terra" });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    const destination = () => container.querySelector(".destination-frame");
    await waitFor(() => expect(destination()).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(destination()?.getAttribute("data-staged-count")).toBe("1"));

    const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
    if (!openDraft) throw new Error("the open-draft control did not render");
    fireEvent.click(openDraft);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());

    const item = () => container.querySelector<HTMLElement>(".collation-item");
    const bodyEl = () =>
      within(item() ?? container).getByLabelText<HTMLTextAreaElement>("Body for item 1");
    fireEvent.change(bodyEl(), { target: { value: "already fine" } });

    await waitFor(() => {
      if (!item()?.querySelector(".collation-refine"))
        throw new Error("Refine control not offered");
    });
    fireEvent.click(within(item() ?? container).getByLabelText("Refine item 1"));

    // The no-change verdict shows and (correctly) hides the Refine button while it stands.
    await waitFor(() => expect(item()?.textContent).toContain("Already clear"));
    expect(within(item() ?? container).queryByLabelText("Refine item 1")).toBeNull();

    // Editing the note invalidates the stale verdict: the message clears and the
    // Refine button returns for the new text.
    fireEvent.change(bodyEl(), { target: { value: "actually this needs a real change" } });
    await waitFor(() => {
      expect(item()?.textContent).not.toContain("Already clear");
      expect(within(item() ?? container).getByLabelText("Refine item 1")).toBeTruthy();
    });
  });
});
