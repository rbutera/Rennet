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
// red-proofable (revert the fix it pins and the test fails).
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

/** A promise whose resolution a test controls, so a run can be held PENDING. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A ready review with `count` changed, not-yet-disposed files, so ReviewWorkspace
// shows a "Mark read" button per file. Mark-read stages a neutral "comment" with an
// EMPTY body — enough to collate, but NOT actionable (an empty ask would compose an
// empty work order), so the loop tests author a real instruction body via the draft
// canvas before the item counts as a handoff ask (see `loadAndStage` / `authorBody`).
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
// caller-chosen outcome (which may be a PENDING promise, for the race tests). Every
// compose bundle is captured so a test can assert the run received the exact one the
// paper previewed. `captureReview`, when supplied, is what `review.capture` returns —
// a DIFFERENT review, so a test can switch reviews through the app's own capture path.
function harness(
  review: Review,
  run: () => RunOutput | Promise<RunOutput>,
  captureReview?: Review,
  failFirstCompose = false,
): Harness {
  const composeCalls: CommandInput<"review.handoff.compose">[] = [];
  const runCalls: CommandInput<"review.handoff.run">[] = [];
  const composed: ComposedBundle[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.handoff.compose") {
      composeCalls.push(input as CommandInput<"review.handoff.compose">);
      // The FIRST compose is a transport failure (the honest error state); a later
      // recompose succeeds — the shape the C5 re-entry test walks.
      if (failFirstCompose && composeCalls.length === 1)
        throw new Error("compose transport failed");
      const bundle = composedBundle(`digest-${composeCalls.length}`);
      composed.push(bundle);
      return { bundle } satisfies CommandOutput<"review.handoff.compose">;
    }
    if (name === "review.handoff.run") {
      runCalls.push(input as CommandInput<"review.handoff.run">);
      return run();
    }
    if (name === "repository.choose") return { path: "/code/other" };
    if (name === "review.capture") return { review: captureReview ?? review };
    if (name === "projects.list") return { projects: [] };
    if (name === "harness.detect") return { detected: [] };
    return { review };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    composeCalls,
    runCalls,
    composed,
  };
}

// Mark the currently-selected file read (stages an EMPTY "comment"), then wait for the
// draft to carry `expectCount` items.
async function markRead(container: HTMLElement, expectCount: number): Promise<void> {
  const mark = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Mark read",
  );
  if (!mark) throw new Error('no "Mark read" button');
  fireEvent.click(mark);
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      String(expectCount),
    ),
  );
}

// Author a real instruction body onto a draft item via the collation draft canvas,
// then return to the frame. Mark-read alone stages an empty comment, which is NOT an
// actionable handoff ask — the reviewer's words are what make it one.
async function authorBody(container: HTMLElement, itemNumber: number, text: string): Promise<void> {
  fireEvent.click(
    container.querySelector<HTMLButtonElement>(".destination-open-draft") as HTMLButtonElement,
  );
  const textarea = await waitFor(() => {
    const el = container.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="Body for item ${itemNumber}"]`,
    );
    if (!el) throw new Error(`no body textarea for item ${itemNumber}`);
    return el;
  });
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(
    container.querySelector<HTMLButtonElement>(".collation-back") as HTMLButtonElement,
  );
  await waitFor(() => expect(container.querySelector(".collation-canvas")).toBeNull());
}

// Load the app, switch to Files, mark the first file read, and author an instruction
// body onto it — one ACTIONABLE handoff ask. Returns the container once the handoff
// affordance is available.
async function loadAndStage(bridge: RennetBridge): Promise<HTMLElement> {
  const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
  await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
  fireEvent.click(getByRole("tab", { name: "Files" }));
  await markRead(container, 1);
  await authorBody(container, 1, "FIX-THIS");
  await waitFor(() => expect(handoffButton(container)).not.toBeNull());
  return container;
}

function handoffButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".destination-handoff");
}

function runButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".handoff-paper-run");
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

    // The paper mounts as a MODAL over the frame — a fixed dialog backdrop, the same
    // shell PublishSheet uses — not a bare section in document flow. (C4.)
    // RED-proof: drop the backdrop wrapper and the paper is no longer inside a dialog.
    const backdrop = container.querySelector('[aria-label="Handoff"]');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("publish-sheet-backdrop")).toBe(true);
    expect(backdrop?.getAttribute("role")).toBe("dialog");
    expect(backdrop?.getAttribute("aria-modal")).toBe("true");
    expect(backdrop?.querySelector(".handoff-paper")).not.toBeNull();

    // The previewed order equals bundle.tasks order (z before a) — the run executes
    // that order. RED-proof: sort tasks in handoffPreview and this fires.
    const html = container.innerHTML;
    expect(html.indexOf("ZEBRA-BODY")).toBeLessThan(html.indexOf("APPLE-BODY"));
    expect(html.indexOf("src/z.ts")).toBeLessThan(html.indexOf("src/a.ts"));
  });

  it("3.2 run passes the SAME bundle the paper previewed; pending shows AND disables the button while unresolved; success renders as success", async () => {
    const gate = deferred<RunOutput>();
    const { bridge, runCalls, composed } = harness(makeReview(1), () => gate.promise);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(runButton(container)).not.toBeNull());

    fireEvent.click(runButton(container) as HTMLButtonElement);

    // Pending is genuinely visible while the run is unresolved (the gate is still
    // open), and the run button is DISABLED so a double-click can't re-fire the run.
    // RED-proof: this is a real pending assertion (the vacuous prior version resolved
    // on a microtask and only ever saw "ran"); revert the pending render and it fires.
    await waitFor(() =>
      expect(container.querySelector('[data-run-status="pending"]')).not.toBeNull(),
    );
    expect(runButton(container)?.disabled).toBe(true);
    expect(container.querySelector('[data-run-status="ran"]')).toBeNull();

    // Resolve → the success outcome renders as success (files touched + carry line).
    gate.resolve(ranOutcome());
    await waitFor(() => expect(container.querySelector('[data-run-status="ran"]')).not.toBeNull());

    // The run received the EXACT bundle the paper composed — same object reference and
    // same digest. RED-proof: recompose or clone before run and the identity fails.
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.bundle).toBe(composed[0]);
    expect(runCalls[0]?.bundle.digest).toBe("digest-1");
    const outcome = container.querySelector('[data-run-status="ran"]');
    expect(outcome?.textContent).toContain("2 files changed");
    expect(outcome?.textContent).toContain("2 carried forward");
  });

  it("3.2b a run that resolves AFTER a disposition change is DROPPED — the stale outcome never lands on the fresh bundle (C2)", async () => {
    const gate = deferred<RunOutput>();
    const { bridge, composeCalls } = harness(makeReview(1), () => gate.promise);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(1));
    await waitFor(() => expect(runButton(container)).not.toBeNull());

    // Start run A; it stays pending (the gate is open).
    fireEvent.click(runButton(container) as HTMLButtonElement);
    await waitFor(() =>
      expect(container.querySelector('[data-run-status="pending"]')).not.toBeNull(),
    );

    // Leave the surface and CHANGE the disposition — this invalidates the bundle (bumps
    // the compose generation and resets the run to idle) while run A is still in flight.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-back") as HTMLButtonElement,
    );
    await waitFor(() => expect(container.querySelector(".handoff-paper")).toBeNull());
    await authorBody(container, 1, "FIX-THIS-DIFFERENTLY");

    // Now resolve the STALE run A. Its outcome belongs to the superseded bundle.
    gate.resolve(ranOutcome());

    // Re-enter the surface: it recomposes (a second compose call) to a FRESH, un-run
    // bundle. The stale run A outcome must NOT have rendered — the run stays idle.
    // RED-proof: drop the generation guard in runHandoff and A's "ran" outcome lands.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(2));
    await waitFor(() => expect(runButton(container)).not.toBeNull());
    expect(container.querySelector('[data-run-status="ran"]')).toBeNull();
    expect(runButton(container)?.disabled).toBe(false);
  });

  it("3.3 a refused outcome renders as a refusal with its reason and no success; a failed outcome renders as an error", async () => {
    const refused: RunOutput = { status: "refused", reason: "stale bundle" };
    const { bridge } = harness(makeReview(1), () => refused);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(runButton(container)).not.toBeNull());
    fireEvent.click(runButton(container) as HTMLButtonElement);

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

  it("3.3b a failed outcome renders as an error AND surfaces the files it mutated before failing (C6)", async () => {
    const failed: RunOutput = {
      status: "failed",
      reason: "harness crashed",
      filesTouched: ["src/z.ts", "src/a.ts"],
    };
    const { bridge } = harness(makeReview(1), () => failed);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(runButton(container)).not.toBeNull());
    fireEvent.click(runButton(container) as HTMLButtonElement);

    const failure = await waitFor(() => {
      const el = container.querySelector('[data-run-status="failed"]');
      if (!el) throw new Error("no failed outcome");
      return el;
    });
    expect(failure.textContent).toContain("harness crashed");
    // A failed agent can still have mutated files — the human must see them, not be
    // told "it failed" while a partial write sits unmentioned. RED-proof: ignore
    // filesTouched on failure (the prior behaviour) and these two assertions fire.
    expect(failure.textContent).toContain("2 files changed before it failed");
    expect(failure.textContent).toContain("src/z.ts");
    expect(container.querySelector('[data-run-status="ran"]')).toBeNull();
  });

  it("3.4 changing a disposition after compose clears the bundle; re-entering composes again and the run uses the fresh bundle", async () => {
    const { bridge, composeCalls, runCalls, composed } = harness(makeReview(2), ranOutcome);
    const container = await loadAndStage(bridge);

    // First compose on entry.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(1));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());

    // Back out, change a disposition (stage a SECOND file AND give it an instruction so
    // it becomes a new actionable ask), re-open handoff.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-back") as HTMLButtonElement,
    );
    await waitFor(() => expect(container.querySelector(".handoff-paper")).toBeNull());
    const secondRow = [...container.querySelectorAll<HTMLButtonElement>(".file-row")].find((row) =>
      row.textContent?.includes("src/f1.ts"),
    );
    fireEvent.click(secondRow as HTMLButtonElement);
    await markRead(container, 2);
    await authorBody(container, 2, "AND-FIX-THIS-TOO");

    // Re-entering recomposes (a second compose call) — the stale bundle was cleared.
    // RED-proof: drop the invalidation effect and this stays at one compose call.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(2));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());

    // The run uses the FRESH (second) bundle, never the stale first one.
    fireEvent.click(runButton(container) as HTMLButtonElement);
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

  it("3.6 a neutral mark-read comment with an EMPTY body is NOT an actionable handoff ask (C3)", async () => {
    const { bridge, composeCalls } = harness(makeReview(1), ranOutcome);
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // Mark read (an empty "comment") — the item collates, but says nothing to act on.
    await markRead(container, 1);

    // No handoff affordance: an empty comment is a read-marker, not a work order.
    // RED-proof: drop the blank-body filter in handoffDispositions and the button
    // appears (and a compose would build an empty instruction).
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    );
    expect(handoffButton(container)).toBeNull();

    // Authoring a real instruction turns it into an actionable ask — the affordance
    // appears only once there is something for the agent to do.
    await authorBody(container, 1, "NOW-DO-THIS");
    await waitFor(() => expect(handoffButton(container)).not.toBeNull());
    expect(composeCalls).toHaveLength(0); // still nothing composed until entry
  });

  it("O1 the run button stays disabled after a terminal outcome — the same bundle is not re-runnable against a mutated tree", async () => {
    const { bridge, runCalls } = harness(makeReview(1), ranOutcome);
    const container = await loadAndStage(bridge);
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(runButton(container)).not.toBeNull());

    fireEvent.click(runButton(container) as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector('[data-run-status="ran"]')).not.toBeNull());

    // After success the button is disabled; a re-click does not re-invoke the run.
    // RED-proof: re-enable the button on terminal outcomes and runCalls hits 2.
    expect(runButton(container)?.disabled).toBe(true);
    fireEvent.click(runButton(container) as HTMLButtonElement);
    expect(runCalls).toHaveLength(1);
  });

  it("C5 a failed compose is not a re-entry dead-end — leaving and reopening the surface recomposes", async () => {
    const { bridge, composeCalls } = harness(makeReview(1), ranOutcome, undefined, true);
    const container = await loadAndStage(bridge);

    // Enter: the first compose throws → the honest error state, no paper.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".handoff-compose-error")).not.toBeNull());
    expect(composeCalls).toHaveLength(1);
    expect(container.querySelector(".handoff-paper")).toBeNull();

    // Leave the surface — the error is not sticky, so the state resets to idle.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".handoff-paper-back") as HTMLButtonElement,
    );
    await waitFor(() => expect(container.querySelector(".handoff-compose-error")).toBeNull());

    // Re-enter WITHOUT any disposition edit: it recomposes (a second call, which now
    // succeeds) and renders the paper.
    // RED-proof: drop the leave-resets-error effect and re-entry stays stuck on the
    // error state — composeCalls stays at 1 and no paper renders.
    fireEvent.click(handoffButton(container) as HTMLButtonElement);
    await waitFor(() => expect(composeCalls).toHaveLength(2));
    await waitFor(() => expect(container.querySelector(".handoff-paper")).not.toBeNull());
  });

  it("C1 switching reviews clears the draft — review B never inherits review A's actionable ask", async () => {
    const reviewB: Review = { ...makeReview(1), id: "review-b", repositoryRoot: "/code/other" };
    const { bridge } = harness(makeReview(1), ranOutcome, reviewB);
    const container = await loadAndStage(bridge);

    // Review A has an actionable ask → the handoff affordance is present.
    expect(handoffButton(container)).not.toBeNull();
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    );

    // Switch to review B through the app's own capture path: ascend to Projects via the
    // breadcrumb root (the rail is gone; the breadcrumb is the way home), then ⌘K →
    // "Review directly" → direct entry → "Choose a repository", which captures a
    // DIFFERENT review (review B, a new id) via review.capture.
    const crumbRoot = container.querySelector(".nav-breadcrumb .nav-breadcrumb-segment");
    fireEvent.click(crumbRoot as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const reviewDirectly = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) =>
        option.textContent?.includes("Review directly"),
      );
      if (!el) throw new Error("no Review directly command");
      return el;
    });
    fireEvent.click(reviewDirectly);
    const choose = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Choose a repository"),
      );
      if (!el) throw new Error("no Choose a repository button");
      return el;
    });
    fireEvent.click(choose);

    // Review B is now open with a CLEARED draft: no actionable ask leaked from A, so no
    // handoff affordance and an empty staged count.
    // RED-proof: drop `setDraft([])` from the reviewId reset effect and B shows A's ask.
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
        "0",
      ),
    );
    expect(handoffButton(container)).toBeNull();
  });
});
