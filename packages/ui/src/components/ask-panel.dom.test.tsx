// @vitest-environment happy-dom
//
// The Ask panel (issue #139, bead workspace-alqow): the affordance that fires the
// live `review.ask` path. This mounts the real `AskPanel` over a recording fake
// `RennetBridge` and drives the whole interaction — type a question, send, see the
// answer — asserting the recorded command input (behavioural) and the rendered
// cards. It also proves the no-synthesis law AT THE SURFACE: "both" renders exactly
// two labelled cards and there is no third (merged) card the panel can produce, and
// that the panel RELAYS a main-issued authorization (never fabricates one).
import type { CommandInput, RennetBridge } from "@rennet/protocol";
import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { mount, waitFor } from "../test/dom";
import { AskPanel } from "./ask-panel";

function fakeBridge(result: AskReviewResult): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    if (name === "review.ask") return result;
    throw new Error(`unexpected command ${name}`);
  };
  return { bridge: { invoke } as RennetBridge, calls };
}

/** No-consent authorize (auto/bypass): the panel passes no token. */
const noAuth = () => Promise.resolve(null);

const orchestratorOnly: AskReviewResult = {
  mode: "orchestrator",
  primary: { model: "Orchestrator · Claude", answer: "It is in milliseconds." },
};

const both: AskReviewResult = {
  mode: "both",
  primary: { model: "Orchestrator · Claude", answer: "Milliseconds; a rename would help." },
  secondOpinion: { model: "codex", answer: "Milliseconds — the wrapper divides by 1000." },
};

describe("AskPanel", () => {
  it("sends review.ask with the reviewId + patchsetId + question and renders the answer", async () => {
    const { bridge, calls } = fakeBridge(orchestratorOnly);
    const { user, getByPlaceholderText, getByText } = mount(
      <AskPanel bridge={bridge} reviewId="review-42" patchsetId="ps-7" authorize={noAuth} />,
    );

    await user.type(getByPlaceholderText("Ask about this review"), "is retry-after seconds or ms?");
    await user.click(getByText("Ask"));

    await waitFor(() => expect(getByText("It is in milliseconds.")).toBeTruthy());
    const ask = calls.find((c) => c.name === "review.ask");
    expect(ask).toBeDefined();
    const input = ask?.input as CommandInput<"review.ask">;
    expect(input.reviewId).toBe("review-42");
    expect(input.patchsetId).toBe("ps-7");
    expect(input.question).toBe("is retry-after seconds or ms?");
    // The default routing never fires a second model.
    expect(input.mode).toBe("orchestrator");
    expect(typeof input.commandId).toBe("string");
    // Auto/bypass → no token relayed.
    expect(input.authorization).toBeUndefined();
  });

  it("relays the main-issued authorization when the mode asks (never fabricates one)", async () => {
    const { bridge, calls } = fakeBridge(orchestratorOnly);
    const authorize = vi.fn(() => Promise.resolve("token-minted-by-main"));
    const { user, getByPlaceholderText, getByText } = mount(
      <AskPanel bridge={bridge} reviewId="review-1" patchsetId="ps-1" authorize={authorize} />,
    );
    await user.type(getByPlaceholderText("Ask about this review"), "why?");
    await user.click(getByText("Ask"));

    await waitFor(() => expect(getByText("It is in milliseconds.")).toBeTruthy());
    expect(authorize).toHaveBeenCalledTimes(1);
    const input = calls.find((c) => c.name === "review.ask")?.input as CommandInput<"review.ask">;
    expect(input.authorization).toBe("token-minted-by-main");
  });

  it("in BOTH mode renders exactly two labelled cards — and no third, merged card", async () => {
    const { bridge, calls } = fakeBridge(both);
    const { user, container, getByPlaceholderText, getByLabelText, getByText } = mount(
      <AskPanel bridge={bridge} reviewId="review-1" patchsetId="ps-1" authorize={noAuth} />,
    );

    // Opt into "both" via the caret menu, then ask.
    await user.click(getByLabelText("ask options"));
    await user.click(getByText("Ask both models"));
    await user.type(getByPlaceholderText("Ask about this review"), "does the client agree?");
    await user.click(getByText("Ask"));

    await waitFor(() => expect(container.querySelectorAll(".ask-answer-card").length).toBe(2));
    const input = calls.find((c) => c.name === "review.ask")?.input as CommandInput<"review.ask">;
    expect(input.mode).toBe("both");
    // Two labelled cards, side by side, and the honest footer — no synthesis card.
    const labels = [...container.querySelectorAll(".ask-answer-head")].map((n) => n.textContent);
    expect(labels).toEqual(["Orchestrator · Claude", "codex"]);
    expect(container.querySelector(".ask-answers-foot")?.textContent).toMatch(/no synthesis/i);
  });

  it("surfaces a command failure instead of silently swallowing it", async () => {
    const failing: RennetBridge = {
      invoke: () => Promise.reject(new Error("the orchestrator is unavailable")),
    } as RennetBridge;
    const { user, getByPlaceholderText, getByText, findByRole } = mount(
      <AskPanel bridge={failing} reviewId="review-1" patchsetId="ps-1" authorize={noAuth} />,
    );
    await user.type(getByPlaceholderText("Ask about this review"), "why?");
    await user.click(getByText("Ask"));
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/unavailable/i);
  });

  it("unblocks with an honest error when a turn never settles (UI timeout)", async () => {
    // A bridge whose invoke never resolves — the panel must not stay pending forever.
    const hung: RennetBridge = {
      invoke: () => new Promise<never>(() => undefined),
    } as RennetBridge;
    const { user, getByPlaceholderText, getByText, findByRole } = mount(
      <AskPanel
        bridge={hung}
        reviewId="review-1"
        patchsetId="ps-1"
        authorize={noAuth}
        timeoutMs={20}
      />,
    );
    await user.type(getByPlaceholderText("Ask about this review"), "why?");
    await user.click(getByText("Ask"));
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/did not answer in time/i);
    // The control is usable again (not permanently disabled).
    await waitFor(() => expect((getByText("Ask") as HTMLButtonElement).disabled).toBe(false));
  });
});
