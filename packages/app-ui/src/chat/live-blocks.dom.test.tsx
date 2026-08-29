// @vitest-environment happy-dom
//
// C07 cluster 3 (task 3.3): the live-narration sub-blocks are STATE-driven off the turn's
// real `status`, not a self-timed `setTimeout` (reconciliation 2). A `streaming` thought
// reads live (spinner, "Thinking", expanded) and collapses to "Thought for Ns" when it
// settles `complete`; an `interrupted` block settles truthfully — no infinite spinner;
// StreamingProse renders instantly when `animate=false` (records replay, never re-arrive).
import { TerminalSquare } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, mount, screen } from "../test/dom";
import { ActionStep } from "./action-step";
import type { ActionStepData, ThoughtBlockData } from "./chat-data";
import { StreamingProse } from "./streaming-prose";
import { ThoughtBlock } from "./thought-block";

afterEach(cleanup);

const thought = (status: ThoughtBlockData["status"]): ThoughtBlockData => ({
  kind: "thought",
  id: "th1",
  status,
  seconds: 4,
  text: ["Public routes should already skip the scoping middleware entirely."],
});

describe("thought block follows real status (task 3.3)", () => {
  it("reads live while streaming and collapses to the summary on complete", () => {
    const { rerender, container } = mount(<ThoughtBlock step={thought("streaming")} />);
    // Live: spinner spinning, "Thinking", expanded.
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");

    // Settled: the spinner stills, the summary flips to "Thought for Ns", collapsed.
    rerender(<ThoughtBlock step={thought("complete")} />);
    expect(screen.getByText(/Thought for 4s/)).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("lets a settled thought re-expand on tap", async () => {
    const { user } = mount(<ThoughtBlock step={thought("complete")} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("an interrupted thought settles truthfully — no infinite spinner", () => {
    const { container } = mount(<ThoughtBlock step={thought("interrupted")} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByText(/Thought for 4s/)).toBeTruthy();
  });

  it("does not invent a duration when the harness reported none", () => {
    mount(<ThoughtBlock step={{ ...thought("complete"), seconds: undefined }} />);
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText(/Thought for/)).toBeNull();
  });
});

const runningStep: ActionStepData = {
  kind: "action",
  id: "ac1",
  label: "Running",
  detail: "pnpm test --filter routes",
  doneLabel: "Ran",
  doneDetail: "pnpm test --filter routes · 7 passed",
  status: "streaming",
  icon: TerminalSquare,
};

describe("action step follows real status (task 3.3)", () => {
  it("spins while running, then shows the done label when settled", () => {
    const { rerender, container } = mount(<ActionStep step={runningStep} />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByText(/Running/)).toBeTruthy();
    const announcement = container.querySelector('[aria-live="polite"]');
    expect(announcement?.textContent).toBe("running");

    rerender(<ActionStep step={{ ...runningStep, status: "complete" }} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByText(/Ran · pnpm test --filter routes · 7 passed/)).toBeTruthy();
    expect(announcement?.textContent).toBe("done");
  });

  it("an interrupted action step settles — no infinite spinner", () => {
    const { container } = mount(<ActionStep step={{ ...runningStep, status: "interrupted" }} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByText("done")).toBeTruthy();
  });
});

describe("streaming prose record-vs-arrival (task 3.3)", () => {
  it("renders instantly when animate=false, word-reveals when animate=true", () => {
    const { container, rerender } = mount(
      <StreamingProse paragraphs={["No impact on the public routes."]} animate={false} />,
    );
    expect(container.querySelectorAll(".animate-word-in").length).toBe(0);
    expect(screen.getByText("No impact on the public routes.")).toBeTruthy();

    act(() =>
      rerender(<StreamingProse paragraphs={["No impact on the public routes."]} animate={true} />),
    );
    expect(container.querySelectorAll(".animate-word-in").length).toBeGreaterThan(0);
  });
});
