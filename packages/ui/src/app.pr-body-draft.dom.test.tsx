// @vitest-environment happy-dom
//
// App-level PR-BODY DRAFT flow (issue #74, M26) — the MOUNTED-APP regression the
// composer/paper unit tests could not give (#74 MED-4). Removing the production
// `body: prBody` spread left all UI tests green because nothing mounted RennetApp
// through model result → composer → paper. These do, over a recording bridge, and
// assert the load-bearing contracts:
//   • HIGH-1: an UNSTAGED (blue) disposition NEVER reaches `review.draftPrBody`, and
//     never appears in the resulting submission — private notes do not egress.
//   • MED-4: a drafted body flows into the composer and the paper's preview bytes.
//   • HIGH-2: the draft Sign (open-paper) is disabled while a draft is in flight.
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

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

type DraftOutput = CommandOutput<"review.draftPrBody">;

/** A bridge that records `review.draftPrBody` inputs and returns a controllable
 *  result — immediate by default, or deferred (resolve manually) to observe the
 *  in-flight state. */
function draftingBridge(ready: Review, drafted: DraftOutput, deferred = false) {
  const calls: CommandInput<"review.draftPrBody">[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "review.draftPrBody") {
      calls.push(input as CommandInput<"review.draftPrBody">);
      if (deferred) await gate;
      return drafted;
    }
    return { review: ready };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    calls,
    release: () => release?.(),
  };
}

/** Drive bootstrap → Files → Mark read (stages a blue comment) → open the draft, and
 *  type `sentinel` into the item's body. Returns the container + role helpers. Leaves
 *  the app in own-branch (the default) where the composer lives. */
async function toDraftWithNote(bridge: RennetBridge, sentinel: string) {
  const handle = mount(<RennetApp bridge={bridge} />);
  const { container, getByRole } = handle;
  await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
  fireEvent.click(getByRole("tab", { name: "Files" }));
  fireEvent.click(getByRole("button", { name: "Mark read" }));
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    ),
  );
  const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
  if (!openDraft) throw new Error("open-draft control missing");
  fireEvent.click(openDraft);
  await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
  const body = container.querySelector<HTMLTextAreaElement>(".collation-item-body");
  if (!body) throw new Error("item body textarea missing");
  fireEvent.change(body, { target: { value: sentinel } });
  return handle;
}

function clickDraftWithAi(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>(".collation-pr-draft-btn");
  if (!btn) throw new Error("Draft with AI button missing");
  fireEvent.click(btn);
}

const DRAFTED: DraftOutput = {
  status: "drafted",
  title: "Bound the fail-open path",
  body: "An honest account of the change.",
  model: "gpt-5.6-luna",
};

describe("RennetApp — PR-body draft never egresses a blue note (#74 HIGH-1)", () => {
  it("an UNSTAGED (blue) disposition never reaches review.draftPrBody", async () => {
    const SENTINEL = "SECRET_BLUE_NOTE::must-never-leave-this-machine";
    const { bridge, calls } = draftingBridge(review, DRAFTED);
    const { container } = await toDraftWithNote(bridge, SENTINEL);
    // The Mark-read comment defaults to BLUE (unstaged) — it stays local.
    clickDraftWithAi(container);
    await waitFor(() => expect(calls).toHaveLength(1));
    const sent = JSON.stringify(calls[0]?.dispositions ?? []);
    // The blue note's body is NOWHERE in the drafting input. RED-proof: revert the
    // producer to `draft.map` (the full draft) and the sentinel appears here.
    expect(sent).not.toContain("SECRET_BLUE_NOTE");
    expect(calls[0]?.dispositions).toEqual([]);
  });

  it("a STAGED (ink) disposition DOES reach review.draftPrBody (positive control)", async () => {
    const SENTINEL = "STAGED_INK_NOTE::this-one-publishes";
    const { bridge, calls } = draftingBridge(review, DRAFTED);
    const { container } = await toDraftWithNote(bridge, SENTINEL);
    // Stage the comment to the PR (ink) — now it is part of what publishes.
    const stage = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
    if (!stage) throw new Error("stage toggle missing");
    fireEvent.click(stage);
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>(".collation-item-stage-box")?.checked).toBe(
        true,
      ),
    );
    clickDraftWithAi(container);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0]?.dispositions ?? [])).toContain("STAGED_INK_NOTE");
  });
});

describe("RennetApp — the drafted body flows to the composer + preview (#74 MED-4)", () => {
  it("a drafted title/body populates the composer fields", async () => {
    const { bridge } = draftingBridge(review, DRAFTED);
    const { container } = await toDraftWithNote(bridge, "some note");
    clickDraftWithAi(container);
    await waitFor(() => {
      const title = container.querySelector<HTMLInputElement>('[data-testid="pr-draft-title"]');
      const body = container.querySelector<HTMLTextAreaElement>('[data-testid="pr-draft-body"]');
      expect(title?.value).toBe("Bound the fail-open path");
      expect(body?.value).toBe("An honest account of the change.");
    });
    // The observed model is shown honestly.
    expect(container.querySelector('[data-testid="pr-draft-status"]')?.textContent).toContain(
      "gpt-5.6-luna",
    );
  });

  it("the drafted-then-EDITED body is what the PAPER previews and signs (the production handoff)", async () => {
    // The uncovered handoff: composer `prDraft.body` → publishContext.submission.body
    // → the paper the human holds-to-sign. Removing the `body: prBody` spread at
    // app.tsx:998 left every composer-only test green — this drives model result →
    // EDIT → paper, so it reddens on exactly that break.
    const { bridge } = draftingBridge(review, DRAFTED);
    const { container } = await toDraftWithNote(bridge, "some note");
    clickDraftWithAi(container);
    const composerBody = () =>
      container.querySelector<HTMLTextAreaElement>('[data-testid="pr-draft-body"]');
    await waitFor(() => expect(composerBody()?.value).toBe("An honest account of the change."));
    // The human edits the drafted body before signing — the paper must carry the edit,
    // not the model's first draft and not the deterministic fallback.
    const EDITED = "EDITED_BODY::this-exact-account-must-reach-the-paper";
    const bodyEl = composerBody();
    if (!bodyEl) throw new Error("composer body textarea missing");
    fireEvent.change(bodyEl, { target: { value: EDITED } });
    await waitFor(() => expect(composerBody()?.value).toBe(EDITED));
    // Open the paper (the hold-to-sign surface) over the settled draft.
    const sign = container.querySelector<HTMLButtonElement>(".collation-sign");
    if (!sign) throw new Error("draft Sign (open-paper) control missing");
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());
    // RED-proof (body handoff, app.tsx:998): drop the spread → "(no description)".
    expect(container.querySelector('[data-testid="pr-body"]')?.textContent).toContain(EDITED);
    // And the drafted title rides the sibling handoff (app.tsx:997) onto the paper.
    expect(container.querySelector(".publish-sheet-pr-title")?.textContent).toBe(
      "Bound the fail-open path",
    );
  });
});

describe("RennetApp — the draft Sign is disabled while a draft is in flight (#74 HIGH-2)", () => {
  it("Sign (open-paper) cannot fire while drafting, then re-enables when it settles", async () => {
    const { bridge, release } = draftingBridge(review, DRAFTED, true);
    const { container } = await toDraftWithNote(bridge, "some note");
    clickDraftWithAi(container);
    // While the turn is pending, the draft Sign is disabled — the paper cannot open
    // mid-draft (the entry to the swap-during-hold hole).
    await waitFor(() =>
      expect(container.querySelector<HTMLButtonElement>(".collation-sign")?.disabled).toBe(true),
    );
    expect(container.querySelector(".publish-sheet")).toBeNull();
    // Settle the draft; Sign re-enables and now opens the paper over a stable draft.
    release();
    await waitFor(() =>
      expect(container.querySelector<HTMLButtonElement>(".collation-sign")?.disabled).toBe(false),
    );
  });
});
