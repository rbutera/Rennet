// @vitest-environment happy-dom
//
// The FAILED-vs-EMPTY app boundary for the Flagged (#148) and Noise (#152) lenses.
//
// A lens runner that FAILS or returns a shape the UI cannot read must reach the
// honest `failed` surface ("Couldn't check — not an all-clear"), NEVER the empty
// surface ("this angle ran clean, it was not skipped"). Before the fix, a rejected
// `flagged.review`/`noise.review` invoke (`.catch(() => undefined)`) or a malformed
// result left the state undefined; `ReviewWorkspace` then defaults undefined to
// `{ status: "ok", … }`, which renders as the ok-EMPTY all-clear — a failed check
// masquerading as a clean one, the exact rubber-stamp Rennet exists to refuse.
//
// These mount the WHOLE `RennetApp` over a fake `RennetBridge`, drive the app to the
// enriched Canvases view, switch to the lens under test, and assert the RENDERED
// surface: a failed/malformed fetch → "Couldn't check" (never "ran clean"); a valid
// empty fetch → "ran clean" (never "Couldn't check"). Behavioural and red-provable
// against the pre-fix boundary.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, fireEvent, mount } from "./test/dom";

/** Drain the microtask queue so React state updates + effect chains settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

// A ready review with one changed file. The Canvases view is the default landing,
// and opening it enriches directly (running the harness is Rennet's whole job, no
// consent gate), so the enriched workspace and its lens switcher render.
const baseReview: Review = {
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

const clone = (): Review => structuredClone(baseReview);

/**
 * A fake bridge that resolves the review + enriched canvases, and serves the two
 * lens fetches from the supplied handlers. A lens with no handler returns a valid
 * EMPTY payload, so the lens NOT under test never contaminates the assertion.
 */
function makeBridge(opts: {
  flagged?: () => Promise<unknown>;
  noise?: () => Promise<unknown>;
}): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: clone() };
      case "review.checkFreshness":
        return { review: clone() };
      case "review.canvases":
        return enriched;
      case "flagged.review":
        return opts.flagged ? opts.flagged() : { status: "ok", findings: [] };
      case "noise.review":
        return opts.noise ? opts.noise() : { status: "ok", groups: [] };
      default:
        return {};
    }
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

/** Mount the app, wait for the enriched workspace, and switch to the named lens. */
async function mountToLens(bridge: RennetBridge, lens: "Flagged" | "Noise") {
  let handle!: ReturnType<typeof mount>;
  await act(async () => {
    handle = mount(<RennetApp bridge={bridge} />);
  });
  await act(async () => {
    await flush();
  });
  // The enriched Canvases workspace (and its lens switcher) must be present.
  expect(handle.container.querySelector(".canvas-app")).not.toBeNull();
  await act(async () => {
    fireEvent.click(handle.getByRole("tab", { name: lens }));
    await flush();
  });
  return handle;
}

describe("RennetApp — the Flagged lens failed-vs-empty boundary (#148)", () => {
  it("a REJECTED flagged.review renders 'Couldn't check', never 'ran clean'", async () => {
    const bridge = makeBridge({
      flagged: () => Promise.reject(new Error("no finding-generation runner")),
    });
    const handle = await mountToLens(bridge, "Flagged");

    expect(handle.container.querySelector(".flagged-failed")).not.toBeNull();
    expect(handle.container.textContent).toContain("Couldn't check");
    // The reason from the rejection is surfaced, not swallowed.
    expect(handle.container.textContent).toContain("no finding-generation runner");
    // The trust-critical assertion: a failure must NOT read as an all-clear.
    expect(handle.container.querySelector(".flagged-empty")).toBeNull();
    expect(handle.container.textContent).not.toContain("ran clean");
  });

  it("a MALFORMED flagged.review payload renders 'Couldn't check', never 'ran clean'", async () => {
    // A shape with no recognised `status` — the runner spoke a language the UI
    // cannot read, so it cannot be trusted as a clean result.
    const bridge = makeBridge({
      flagged: () => Promise.resolve({ unexpected: "shape" }),
    });
    const handle = await mountToLens(bridge, "Flagged");

    expect(handle.container.querySelector(".flagged-failed")).not.toBeNull();
    expect(handle.container.textContent).toContain("Couldn't check");
    expect(handle.container.querySelector(".flagged-empty")).toBeNull();
    expect(handle.container.textContent).not.toContain("ran clean");
  });

  it("a valid EMPTY flagged.review renders 'ran clean' (the honest all-clear), never 'Couldn't check'", async () => {
    const bridge = makeBridge({
      flagged: () => Promise.resolve({ status: "ok", findings: [] }),
    });
    const handle = await mountToLens(bridge, "Flagged");

    expect(handle.container.querySelector(".flagged-empty")).not.toBeNull();
    expect(handle.container.textContent).toContain("ran clean");
    // The empty path is unchanged: it must NOT be mistaken for a failure.
    expect(handle.container.querySelector(".flagged-failed")).toBeNull();
    expect(handle.container.textContent).not.toContain("Couldn't check");
  });
});

describe("RennetApp — the Noise lens failed-vs-empty boundary (#152)", () => {
  it("a REJECTED noise.review renders 'Couldn't check', never 'ran clean'", async () => {
    const bridge = makeBridge({
      noise: () => Promise.reject(new Error("no noise-classification runner")),
    });
    const handle = await mountToLens(bridge, "Noise");

    expect(handle.container.querySelector(".noise-failed")).not.toBeNull();
    expect(handle.container.textContent).toContain("Couldn't check");
    expect(handle.container.textContent).toContain("no noise-classification runner");
    expect(handle.container.querySelector(".noise-empty")).toBeNull();
    expect(handle.container.textContent).not.toContain("ran clean");
  });

  it("a MALFORMED noise.review payload renders 'Couldn't check', never 'ran clean'", async () => {
    const bridge = makeBridge({
      noise: () => Promise.resolve({ unexpected: "shape" }),
    });
    const handle = await mountToLens(bridge, "Noise");

    expect(handle.container.querySelector(".noise-failed")).not.toBeNull();
    expect(handle.container.textContent).toContain("Couldn't check");
    expect(handle.container.querySelector(".noise-empty")).toBeNull();
    expect(handle.container.textContent).not.toContain("ran clean");
  });

  it("a valid EMPTY noise.review renders 'ran clean' (the honest all-clear), never 'Couldn't check'", async () => {
    const bridge = makeBridge({
      noise: () => Promise.resolve({ status: "ok", groups: [] }),
    });
    const handle = await mountToLens(bridge, "Noise");

    expect(handle.container.querySelector(".noise-empty")).not.toBeNull();
    expect(handle.container.textContent).toContain("ran clean");
    expect(handle.container.querySelector(".noise-failed")).toBeNull();
    expect(handle.container.textContent).not.toContain("Couldn't check");
  });
});
