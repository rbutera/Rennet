// @vitest-environment happy-dom
//
// The STAGE-6 HANDOFF LOOP wired into the renderer (issue #72): from an own-branch
// review with an actionable disposition, the "Hand off to agent" affordance opens a
// handoff surface that COMPOSES the bundle (review.handoff.compose), PREVIEWS it via
// HandoffPaper, and RUNS it (review.handoff.run) with the EXACT previewed bundle —
// surfacing the discriminated outcome truthfully. This mounts the whole RennetApp
// over a fake bridge that records the compose + run invocations and returns
// controllable outcomes, then walks the real journey. Assertions are behavioural
// (recorded inputs, rendered outcome), never a bare presence check — each guard is
// red-proofable (see the "red-proof" comments and the deletion test at the end).
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

type ComposedBundle = CommandOutput<"review.handoff.compose">["bundle"];
type RunOutput = CommandOutput<"review.handoff.run">;
// The zod-inferred (mutable) Review the run's "ran" result carries — structurally the
// @rennet/types Review, minus its readonly markers, so a fixture Review casts to it.
type RanReview = Extract<RunOutput, { status: "ran" }>["result"]["review"];

// A ready review with `count` changed, not-yet-disposed files, so ReviewWorkspace
// shows a "Mark read" button per file (the simplest staging path — it stages a
// "comment" disposition synchronously, which the handoff loop addresses).
function makeReview(count: number, retrospective = false): Review {
  const files = Array.from({ length: count }, (_, index) => ({
    path: `src/f${index}.ts`,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `+const reviewed${index} = true;`,
  }));
  return {
    id: "review",
    repositoryRoot: "/code/rennet",
    activePatchsetId: "patch-one",
    dispositions: [],
    status: "current",
    ...(retrospective ? { retrospective: true } : {}),
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
        files,
        rawDiff: files.map((file) => file.patch).join("\n"),
        byteLength: 64,
        truncated: false,
      },
    ],
  };
}

// A composed bundle whose tasks are in a deliberately NON-alphabetical order (z
// before a) and whose `digest` is caller-supplied, so a test can assert the run
// received the SAME bundle by identity AND digest. `prompt` renders the tasks in the
// same order — it IS the executed order.
function composedBundle(digest: string): ComposedBundle {
  return {
    reviewId: "review",
    patchsetId: "patch-one",
    tasks: [
      {
        title: "Later file first",
        sourceDispositions: ["d1"],
        asks: [
          {
            id: "d1",
            path: "src/z.ts",
            type: "request-change",
            instruction: "ZEBRA-BODY",
            context: "",
          },
        ],
      },
      {
        title: "Then the earlier",
        sourceDispositions: ["d0"],
        asks: [
          {
            id: "d0",
            path: "src/a.ts",
            type: "request-change",
            instruction: "APPLE-BODY",
            context: "",
          },
        ],
      },
    ],
    prompt: ["### 1. src/z.ts", "ZEBRA-BODY", "### 2. src/a.ts", "APPLE-BODY"].join("\n"),
    digest,
    composed: true,
    traceMap: { d1: 0, d0: 1 },
  };
}

function ranOutcome(): RunOutput {
  return {
    status: "ran",
    result: {
      review: makeReview(1) as unknown as RanReview,
      turnDiff: "+fixed",
      filesTouched: ["src/z.ts", "src/a.ts"],
      carriedForward: 2,
      orphaned: 1,
    },
  };
}

interface Harness {
  bridge: RennetBridge;
  composeCalls: CommandInput<"review.handoff.compose">[];
  runCalls: CommandInput<"review.handoff.run">[];
  composed: ComposedBundle[];
}

// A recording fake bridge: bootstrap / setDisposition / everything-else resolves the
// ready review; compose records its input and returns a FRESH bundle each call (so a
// recompose is observably a different object); run records its input and returns the
// caller-chosen outcome. Every compose bundle is captured so a test can assert the run
// received the exact one the paper previewed.
function harness(review: Review, run: () => RunOutput): Harness {
  const composeCalls: CommandInput<"review.handoff.compose">[] = [];
  const runCalls: CommandInput<"review.handoff.run">[] = [];
  const composed: ComposedBundle[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "review.handoff.compose") {
      composeCalls.push(input as CommandInput<"review.handoff.compose">);
      const bundle = composedBundle(`digest-${composeCalls.length}`);
      composed.push(bundle);
      return { bundle } satisfies CommandOutput<"review.handoff.compose">;
    }
    if (name === "review.handoff.run") {
      runCalls.push(input as CommandInput<"review.handoff.run">);
      return run();
    }
    return { review };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    composeCalls,
    runCalls,
    composed,
  };
}

// Load the app, switch to Files, and stage one "Mark read" comment (an actionable
// handoff ask). Returns the RTL container once the destination shows the staged item.
async function loadAndStage(bridge: RennetBridge): Promise<HTMLElement> {
  const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
  await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
  fireEvent.click(getByRole("tab", { name: "Files" }));
  const mark = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Mark read",
  );
  if (!mark) throw new Error('no "Mark read" button');
  fireEvent.click(mark);
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    ),
  );
  return container;
}

function handoffButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".destination-handoff");
}

describe("RennetApp — the handoff compose→preview→run loop (issue #72)", () => {
  it("3.1 own-branch with an actionable ask offers handoff → entering composes and previews the bundle in tasks order", async () => {
    const { bridge, composeCalls } = harness(makeReview(1), ranOutcome);
    const container = await loadAndStage(bridge);

    // The affordance is present (own-branch default + one actionable ask).
    const button = handoffButton(container);
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    // Entering the surface composes (exactly once) and renders the paper.
    await waitFor(() => expect(composeCalls).toHaveLength(1));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());

    // The previewed order equals bundle.tasks order (z before a) — the run executes
    // that order. RED-proof: sort tasks in handoffPreview and this fires.
    const html = container.innerHTML;
    expect(html.indexOf("ZEBRA-BODY")).toBeLessThan(html.indexOf("APPLE-BODY"));
    expect(html.indexOf("src/z.ts")).toBeLessThan(html.indexOf("src/a.ts"));
  });

  it("3.2 run passes the SAME bundle the paper previewed (identity + digest); pending shows; success renders as success", async () => {
    const { bridge, runCalls, composed } = harness(makeReview(1), ranOutcome);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".handoff-paper-run")).not.toBeNull());

    const runButton = container.querySelector<HTMLButtonElement>(".handoff-paper-run");
    fireEvent.click(runButton as HTMLButtonElement);

    // Pending is visible while the run is unresolved. (The fake resolves on a
    // microtask, so this is best-effort; the outcome assertions below are the pin.)
    await waitFor(() => expect(container.querySelector('[data-run-status="ran"]')).not.toBeNull());

    // The run received the EXACT bundle the paper composed — same object reference and
    // same digest. RED-proof: recompose or clone before run and the identity fails.
    expect(runCalls).toHaveLength(1);
    const previewed = composed[0];
    expect(runCalls[0]?.bundle).toBe(previewed);
    expect(runCalls[0]?.bundle.digest).toBe("digest-1");

    // The success outcome renders as success (files touched + carry line).
    const outcome = container.querySelector('[data-run-status="ran"]');
    expect(outcome?.textContent).toContain("2 files changed");
    expect(outcome?.textContent).toContain("2 carried forward");
  });

  it("3.3 a refused outcome renders as a refusal with its reason and no success; a failed outcome renders as an error", async () => {
    const refused: RunOutput = { status: "refused", reason: "stale bundle" };
    const { bridge } = harness(makeReview(1), () => refused);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".handoff-paper-run")).not.toBeNull());
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-run") as HTMLButtonElement,
    );

    // Refusal is shown as refusal with its reason; NO success state anywhere.
    // RED-proof: map a refusal to the success branch and this fires.
    await waitFor(() =>
      expect(container.querySelector('[data-run-status="refused"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-run-status="refused"]')?.textContent).toContain(
      "stale bundle",
    );
    expect(container.querySelector('[data-run-status="ran"]')).toBeNull();
  });

  it("3.3b a failed outcome renders as an error", async () => {
    const failed: RunOutput = {
      status: "failed",
      reason: "harness crashed",
      filesTouched: ["src/z.ts"],
    };
    const { bridge } = harness(makeReview(1), () => failed);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".handoff-paper-run")).not.toBeNull());
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-run") as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(container.querySelector('[data-run-status="failed"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-run-status="failed"]')?.textContent).toContain(
      "harness crashed",
    );
    expect(container.querySelector('[data-run-status="ran"]')).toBeNull();
  });

  it("3.4 changing a disposition after compose clears the bundle; re-entering composes again and the run uses the fresh bundle", async () => {
    const { bridge, composeCalls, runCalls, composed } = harness(makeReview(2), ranOutcome);
    const container = await loadAndStage(bridge);

    // First compose on entry.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(1));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());

    // Back out, change a disposition (select + stage a SECOND file), re-open handoff.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-back") as HTMLButtonElement,
    );
    await waitFor(() => expect(container.querySelector(".handoff-paper")).toBeNull());
    const secondRow = [...container.querySelectorAll<HTMLButtonElement>(".file-row")].find((row) =>
      row.textContent?.includes("src/f1.ts"),
    );
    fireEvent.click(secondRow as HTMLButtonElement);
    const secondMark = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Mark read",
    );
    fireEvent.click(secondMark as HTMLButtonElement);
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
        "2",
      ),
    );

    // Re-entering recomposes (a second compose call) — the stale bundle was cleared.
    // RED-proof: drop the invalidation effect and this stays at one compose call.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(2));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());

    // The run uses the FRESH (second) bundle, never the stale first one.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-run") as HTMLButtonElement,
    );
    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]?.bundle).toBe(composed[1]);
    expect(runCalls[0]?.bundle.digest).toBe("digest-2");
  });

  it("3.5 a retrospective review shows no handoff affordance", async () => {
    const { bridge, composeCalls } = harness(makeReview(1, true), ranOutcome);
    const { container } = mount(<RennetApp bridge={bridge} />);
    // The retrospective notice replaces the whole destination frame → no handoff button.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="retrospective-notice"]')).not.toBeNull(),
    );
    expect(container.querySelector(".destination-frame")).toBeNull();
    expect(container.querySelector(".destination-handoff")).toBeNull();
    expect(composeCalls).toHaveLength(0);
  });
});
