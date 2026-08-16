// @vitest-environment happy-dom
//
// Whole-`RennetApp` proofs for the unified conversation panel (issue #36), the two
// the component tests could not give:
//   • HIGH-1 (no reflow): the SHIPPED app renders the review-heart split, with the
//     diff column and the conversation panel shell as FLEX SIBLINGS — so opening or
//     expanding the panel changes only the sibling. The component test that hand-built the wrapper could
//     not prove the app renders it; this does.
//   • HIGH-3 (privacy at the REAL boundary): a private thread's content never reaches
//     the actual publish construction (`publish.review` comments + payload) or the
//     paper the human signs. The model-level canary scanned only `threadContentFor-
//     Publish`; this scans the outbound the engine records, with a thread MOUNTED and
//     carrying a canary, red-proofable by a real fifth door.
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { AskReviewResult, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
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

// A DISTINCT canary in every body of a realistic thread (#36 F-A): the earlier fix
// only planted canaries in the first question/answer pair, so a later private message
// entered the published bytes unnoticed. A canary proves only what it sits in front of,
// so the thread here spans TWO turns AND a fragment sub-thread, and each of the six
// bodies — human and model — carries its own token. If ANY appears in published output,
// a private thread leaked (criterion 2). The human-authored halves (q*) are the ones
// that hold a pasted credential.
const Q1 = "CANARY_Q1_HUMAN::must-never-be-published";
const A1 = "CANARY_A1_HARNESS::must-never-be-published";
// ⚠️ Q2 carries JSON-significant characters — a quote, a backslash, a newline — which
// are exactly what a real pasted secret looks like and exactly what `JSON.stringify`
// escapes. A raw-text search of the serialised call would miss this body even when it
// reached the wire semantically unchanged; the structured comparison below does not.
const Q2 = 'CANARY_Q2_HUMAN_LATER "quoted secret" back\\slash\nnewline::must-never-be-published';
const A2 = "CANARY_A2_HARNESS_LATER::must-never-be-published";
const Q3 = "CANARY_Q3_HUMAN_SUBTHREAD::must-never-be-published";
const A3 = "CANARY_A3_HARNESS_SUBTHREAD::must-never-be-published";

function harness() {
  const publishCalls: CommandInput<"publish.review">[] = [];
  const askCalls: CommandInput<"review.ask">[] = [];
  // Each `review.ask` turn returns the next distinct answer, so answers never repeat
  // across turns — a later answer is a genuinely different body.
  const answers = [A1, A2, A3];
  let turn = 0;
  const invoke = async (name: string, _input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.canvases") return { canvases: demoCanvases(), elementDiffs: {} };
    if (name === "review.reattach") return { threads: [] };
    if (name === "review.ask") {
      const input = _input as CommandInput<"review.ask">;
      askCalls.push(input);
      const mode = input.mode ?? "orchestrator";
      const answer: AskReviewResult = {
        mode,
        primary: {
          model: "Claude",
          answer: `A private research answer. ${answers[Math.min(turn, answers.length - 1)]}`,
        },
        ...(mode === "both"
          ? { secondOpinion: { model: "codex", answer: "A separate Codex answer." } }
          : {}),
      };
      turn += 1;
      return answer;
    }
    if (name === "publish.review") {
      publishCalls.push(_input as CommandInput<"publish.review">);
      const output: CommandOutput<"publish.review"> = {
        dryRun: true,
        request: {
          endpoint: "https://api.github.com/graphql",
          method: "POST",
          body: { query: "mutation {}", variables: {} },
        },
        marker: "a".repeat(64),
        ledger: [],
        outcome: null,
      };
      return output;
    }
    return { review };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    publishCalls,
    askCalls,
  };
}

/** Ask through the panel's one composer, which targets its currently active thread. */
async function askInPanel(panel: Element, question: string, expectAnswer: string) {
  const input = panel.querySelector<HTMLTextAreaElement>(".conversation-panel-input");
  const send = panel.querySelector<HTMLButtonElement>(".conversation-panel-send");
  if (!input || !send) throw new Error("no composer in the conversation panel");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(send);
  await waitFor(() => expect(panel.textContent?.includes(expectAnswer)).toBe(true));
}

function toCanvasesView(getByRole: (r: string, o: { name: string }) => HTMLElement) {
  fireEvent.click(getByRole("tab", { name: "Canvases" }));
}

/** Open a private thread (margin discuss) and ask a canary-bearing question, so both the
 *  human question and the harness answer carry a canary. Used by the HIGH-1 no-reflow test. */
async function openThreadWithCanary(container: HTMLElement): Promise<void> {
  const panel = container.querySelector<HTMLElement>(".conversation-panel");
  if (!panel) throw new Error("no conversation panel in the canvas view");
  const discuss = panel.querySelector<HTMLButtonElement>(".discuss-control");
  if (!discuss) throw new Error("no margin discuss control in the canvas view");
  fireEvent.click(discuss);
  await waitFor(() =>
    expect(
      panel?.querySelector(".conversation-panel-composer")?.getAttribute("data-thread-id"),
    ).toBeTruthy(),
  );
  await askInPanel(panel, `why fail open? ${Q1}`, A1);
}

describe("RennetApp — the review-heart split ships (issue #36 HIGH-1, no reflow)", () => {
  it("renders one conversation stream beside the diff and keeps both-model comparison reachable", async () => {
    const { bridge } = harness();
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
    toCanvasesView(getByRole);
    await waitFor(() => expect(container.querySelector(".review-heart-split")).not.toBeNull());
    const split = container.querySelector<HTMLElement>(".review-heart-split");
    if (!split) throw new Error("the shipped app did not render the split");
    // Both are DIRECT children of the split — siblings, not stacked. This is exactly
    // what the hand-built component test could not prove about the shipped app.
    const diff = split.querySelector<HTMLElement>(":scope > .diff-column");
    const panelShell = split.querySelector<HTMLElement>(":scope > .conversation-panel-shell");
    expect(diff).not.toBeNull();
    expect(panelShell).not.toBeNull();
    expect(split.querySelectorAll(".conversation-panel-stream")).toHaveLength(1);

    expect(container.querySelector(".ask-panel")).toBeNull();
    const composer = panelShell?.querySelector<HTMLElement>(".conversation-panel-composer");
    const options = composer?.querySelector<HTMLButtonElement>('[aria-label="ask options"]');
    if (!options) throw new Error("both-model routing is not reachable from the one composer");
    fireEvent.click(options);
    expect(composer?.querySelector('.ask-menu-item[data-mode="both"]')).not.toBeNull();
  });

  it("opening and expanding the panel leave the diff column's allocation untouched", async () => {
    const { bridge } = harness();
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
    toCanvasesView(getByRole);
    await waitFor(() => expect(container.querySelector(".review-heart-split")).not.toBeNull());
    const diffColumn = () =>
      container.querySelector<HTMLElement>(".review-heart-split > .diff-column");
    const diffBefore = diffColumn();
    const beforeNodes = diffBefore?.querySelectorAll("*").length ?? -1;
    expect(beforeNodes).toBeGreaterThan(0);
    expect(diffBefore?.className).toBe("diff-column");
    // Open a thread in the margin.
    await openThreadWithCanary(container);
    expect(container.querySelector(".conversation-panel .chat-row")).not.toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(".conversation-panel-expand");
    if (!expand) throw new Error("no conversation expand control");
    fireEvent.click(expand);
    expect(container.querySelector(".conversation-panel--expanded")).not.toBeNull();

    // The exact same diff element retains its DOM and class contract. Expansion is
    // carried ONLY by the inner panel, whose fixed-width shell stays the direct flex
    // sibling. RED-proof: move the expanded class to the diff or its shell and these
    // assertions fail; unlike happy-dom's always-zero offsetWidth, this is structural.
    const diffAfter = diffColumn();
    expect(diffAfter).toBe(diffBefore);
    expect(diffAfter?.querySelectorAll("*").length).toBe(beforeNodes);
    expect(diffAfter?.className).toBe("diff-column");
    const panelShell = container.querySelector<HTMLElement>(
      ".review-heart-split > .conversation-panel-shell",
    );
    expect(panelShell?.className).toBe("conversation-panel-shell");
    expect(panelShell?.querySelector(":scope > .conversation-panel--expanded")).not.toBeNull();

    fireEvent.click(expand);
    expect(container.querySelector(".conversation-panel--expanded")).toBeNull();
  });

  it("asks the orchestrator from the panel directly, with no permission step", async () => {
    const { bridge, askCalls } = harness();
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
    toCanvasesView(getByRole);
    await waitFor(() => expect(container.querySelector(".conversation-panel")).not.toBeNull());
    const panel = container.querySelector<HTMLElement>(".conversation-panel");
    if (!panel) throw new Error("no conversation panel");

    await askInPanel(panel, "What should I review first?", A1);

    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]).toMatchObject({
      reviewId: review.id,
      mode: "orchestrator",
      question: "What should I review first?",
    });
    expect(askCalls[0] && "permission" in askCalls[0]).toBe(false);
    expect(panel.querySelectorAll(".conversation-panel-stream")).toHaveLength(1);
    expect(panel.querySelector('[data-ask-type="general-ask"] .replychip')).toBeNull();
  });
});

describe("RennetApp — a private thread never reaches the publish boundary (issue #36 HIGH-3)", () => {
  it("with a canary thread MOUNTED, the signed review's comments/payload/paper carry nothing of it", async () => {
    const { bridge, publishCalls } = harness();
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());

    // Stage a real, UNRELATED disposition to publish: mark the file read (a comment),
    // pick the other-PR act (`publish.review`), stage it to ink.
    fireEvent.click(getByRole("tab", { name: "Files" }));
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
        "1",
      ),
    );
    fireEvent.click(getByRole("tab", { name: "Review to post" }));
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-mode")).toBe(
        "other-pr",
      ),
    );

    // Switch to the Canvases view and build a REALISTIC thread: two turns, then a
    // fragment sub-thread — six bodies, each with its own canary. The threads stay
    // mounted (canvas view) while the paper — always-present chrome — signs.
    toCanvasesView(getByRole);
    await waitFor(() => expect(container.querySelector(".conversation-panel")).not.toBeNull());
    const panel = container.querySelector<HTMLElement>(".conversation-panel");
    if (!panel) throw new Error("no conversation panel");
    // Turn 1 (margin discuss): q1 → a1.
    fireEvent.click(panel.querySelector(".discuss-control") as HTMLButtonElement);
    await waitFor(() =>
      expect(
        panel.querySelector(".conversation-panel-composer")?.getAttribute("data-thread-id"),
      ).toBeTruthy(),
    );
    await askInPanel(panel, `why fail open? ${Q1}`, A1);
    // Turn 2 in the SAME thread (a LATER human message + a later answer): q2 → a2.
    await askInPanel(panel, `and then what? ${Q2}`, A2);
    // A fragment SUB-THREAD on the first harness answer → a SECOND thread: q3 → a3.
    fireEvent.click(panel.querySelector(".thread-promote-btn.is-subthread") as HTMLButtonElement);
    await waitFor(() =>
      expect(
        panel.querySelector(".conversation-panel-composer")?.getAttribute("data-anchor-kind"),
      ).toBe("fragment"),
    );
    await askInPanel(panel, `what do you mean? ${Q3}`, A3);

    // Open the draft, stage the comment to ink, freeze the paper, and hold-to-sign.
    fireEvent.click(container.querySelector(".destination-open-draft") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
    fireEvent.click(container.querySelector(".collation-item-stage-box") as HTMLInputElement);
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>(".collation-item-stage-box")?.checked).toBe(
        true,
      ),
    );
    fireEvent.click(container.querySelector(".collation-sign") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());
    const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
    if (!sign) throw new Error("no paper sign control");
    fireEvent.mouseDown(sign);
    await new Promise((resolve) => setTimeout(resolve, 850));
    fireEvent.mouseUp(sign);
    await waitFor(() => expect(publishCalls).toHaveLength(1));

    // ⭐ The proof is over the CORPUS DERIVED FROM THE LIVE DOM, not an enumerated canary
    // list (#36 F-A, fourth round). Every mounted `.chat-message-text` — human and model,
    // every turn, every thread — is a forbidden string; a ten-turn fixture is covered
    // automatically because the corpus grows WITH the fixture instead of being listed
    // beside it. (Route 1 — a purely structural "the publish construction reads no thread
    // state" — is only half-expressible: `canvas/publish.ts` genuinely takes no
    // conversation argument, but the demonstrated leak is `signPaper` reading the DOM
    // directly at `app.tsx`, which no import/parameter shape forbids. So the corpus scan is
    // the honest proof, and its limit is named: it catches a body that reaches the
    // outbound, not one that a future door might paraphrase.)
    const corpus = Array.from(panel.querySelectorAll(".chat-message-text"))
      .map((node) => node.textContent ?? "")
      .filter((text) => text.trim() !== "");

    // POSITIVE CONTROL: the corpus is non-empty and spans multiple turns/threads (six
    // bodies), AND the scan actually bites — a string containing a corpus body is flagged.
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    expect(`prefix ${corpus[0]} suffix`.includes(corpus[0] as string)).toBe(true);

    // THE INVARIANT: no thread body of ANY turn or thread appears in the STRUCTURED
    // outbound. ⚠️ Compare against the real values, NOT `JSON.stringify(call)` — a needle
    // valid on the DOM text is INVALID on the serialised form, because `JSON.stringify`
    // escapes exactly the quotes / backslashes / newlines a real secret contains (Q2
    // carries all three). So inspect each `comments[].body` directly, and PARSE `payload`
    // before inspecting ITS comment bodies. The paper is DOM text (untransformed), scanned
    // raw. RED-proof: fold any `.chat-message-text` (e.g. index 2, the quote/newline
    // body) into `comments[0].body` in `signPaper` — the structured check reddens where a
    // `JSON.stringify(...).includes(body)` check stayed green.
    const call = publishCalls[0];
    if (!call) throw new Error("no publish.review call recorded");
    const parsedPayload = JSON.parse(call.payload) as { comments: { body: string }[] };
    const sentBodies = [
      ...call.comments.map((comment) => comment.body),
      ...parsedPayload.comments.map((comment) => comment.body),
    ];
    const paperText = container.querySelector(".publish-sheet")?.textContent ?? "";
    for (const body of corpus) {
      for (const sent of sentBodies) expect(sent.includes(body)).toBe(false);
      expect(paperText.includes(body)).toBe(false);
    }
  });
});
