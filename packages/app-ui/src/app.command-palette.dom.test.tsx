// @vitest-environment happy-dom
//
// The ⌘K command palette, wired app-wide (wireframes screen 16). This mounts the
// WHOLE `RennetApp` over a fake bridge that lands on the review workspace, presses
// ⌘K (a window-level shortcut, so it fires regardless of focus), and drives a
// command end-to-end: filtering to "Show Files view" and running it must actually
// switch the app to the Files view. The assertion is behavioural (the Files surface
// renders), never a presence check on the palette alone.
import type { RennetBridge, Review } from "@rennet/protocol";
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

// A lenient bridge: bootstrap/freshness resolve the ready review; the flagged/noise
// fetches return honest empties; the canvases load rejects (→ the honest "failed"
// primer) so the test stays on the workspace screen without a full canvas set. The
// workspace's own commands are live regardless of the canvas load.
function bridge(): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.checkFreshness") return { review };
    if (name === "flagged.review") return { status: "ok", findings: [] };
    if (name === "noise.review") return { status: "ok", groups: [] };
    if (name === "openspec.change") return null;
    // review.canvases + anything else: unavailable in this test.
    throw new Error(`unhandled ${name}`);
  };
  return { invoke } as RennetBridge;
}

describe("RennetApp — ⌘K command palette", () => {
  it("opens on ⌘K and runs a command that switches the app to the Files view", async () => {
    const { user, getByLabelText, getByText } = mount(<RennetApp bridge={bridge()} />);

    // Land on the workspace (the view toggle appears once a review is open).
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    // ⌘K from anywhere opens the palette (window-level listener).
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector(".command-palette")).toBeTruthy());

    // Filter to the Files command and run it.
    await user.type(getByLabelText("Search commands"), "Files");
    await user.keyboard("{Enter}");

    // The real handler fired: the app is now on the Files view (its "Changes" panel).
    await waitFor(() => expect(getByText("Changes")).toBeTruthy());
    // The palette closed after running.
    expect(document.querySelector(".command-palette")).toBeNull();
  });

  it("toggles closed on a second ⌘K", async () => {
    const { getByText } = mount(<RennetApp bridge={bridge()} />);
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector(".command-palette")).toBeTruthy());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector(".command-palette")).toBeNull());
  });
});

// The lifted view store is app-lifetime now (for the palette), so the review-change
// effect MUST reset its review-scoped state. Without that reset, opening review B
// after driving review A to the Flagged lens at a deeper zoom would show B on A's
// lens/zoom — carrying A's selection into a review where that hunk does not exist.
function reviewWith(id: string, root: string): Review {
  return {
    id,
    repositoryRoot: root,
    activePatchsetId: `${id}-patch`,
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: `${id}-patch`,
        createdAt: "2026-08-08T00:00:00.000Z",
        repository: {
          id: `${id}-repo`,
          root,
          commonDir: `${root}/.git`,
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
}

describe("RennetApp — the lifted store resets on review change (regression)", () => {
  it("opens review B on the clean default lens/zoom, not review A's Flagged/deeper view", async () => {
    const reviewA = reviewWith("review-a", "/code/a");
    const reviewB = reviewWith("review-b", "/code/b");
    // Whichever review is captured next (the direct-entry door opens B).
    let nextCapture = reviewB;
    const byId: Record<string, Review> = { "review-a": reviewA, "review-b": reviewB };
    const enriched = { canvases: demoCanvases(), elementDiffs: {} };
    const invoke = async (name: string, input: unknown): Promise<unknown> => {
      if (name === "app.bootstrap") return { review: reviewA, repositoryPresent: true };
      if (name === "review.checkFreshness") {
        const id = (input as { reviewId: string }).reviewId;
        return { review: byId[id] ?? reviewA };
      }
      if (name === "review.canvases") return enriched;
      if (name === "flagged.review") return { status: "ok", findings: [] };
      if (name === "noise.review") return { status: "ok", groups: [] };
      if (name === "openspec.change") return null;
      // Front-door mount + the direct-entry capture door.
      if (name === "projects.list") return { projects: [] };
      if (name === "harness.detect") return { harness: null };
      if (name === "fs.listDir")
        // The in-app directory picker modal browses here (native OS dialog retired).
        return {
          result: {
            path: reviewB.repositoryRoot,
            home: reviewB.repositoryRoot,
            parent: null,
            entries: [],
          },
        };
      if (name === "repository.choose") return { path: reviewB.repositoryRoot };
      if (name === "review.capture") return { review: nextCapture };
      throw new Error(`unhandled ${name}`);
    };
    const { user, container, getByRole, getByText } = mount(
      <RennetApp bridge={{ invoke } as RennetBridge} />,
    );

    // Review A's workspace (the enriched canvas set) renders.
    await waitFor(() => expect(container.querySelector(".canvas-app")).toBeTruthy());

    // Drive A to the Flagged lens via ⌘K, then zoom in — moving off the defaults.
    async function runCommand(query: string): Promise<void> {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      await waitFor(() => expect(document.querySelector(".command-palette")).toBeTruthy());
      await user.type(document.querySelector(".command-palette-input") as HTMLElement, query);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(document.querySelector(".command-palette")).toBeNull());
    }
    await runCommand("Go to Flagged lens");
    await waitFor(() =>
      expect(container.querySelector(".lens-tab.is-active")?.textContent).toBe("Flagged"),
    );
    await runCommand("Zoom in");
    await waitFor(() => expect(container.querySelector(".zoom-level")?.textContent).toBe("Cohort"));

    // Back to projects, then open review B through the palette-only direct-entry seam.
    nextCapture = reviewB;
    await runCommand("Back to projects");
    await waitFor(() => expect(container.querySelector(".front-door")).toBeTruthy());
    expect(container.querySelector(".front-door-direct")).toBeNull();
    await runCommand("Review directly");
    await user.click(getByText("Choose a repository"));
    // The in-app picker modal opens; pick the browsed path, then Continue captures it.
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(getByRole("button", { name: /Continue/ }));

    // Review B's workspace renders — and it is CLEAN: the default Decisions lens at
    // the Roll-up altitude, not A's Flagged/Cohort view (the regression this guards).
    await waitFor(() => expect(container.querySelector(".canvas-app")).toBeTruthy());
    await waitFor(() =>
      expect(container.querySelector(".lens-tab.is-active")?.textContent).toBe("Decisions"),
    );
    expect(container.querySelector(".zoom-level")?.textContent).toBe("Roll-up");
    // This heavy two-review render passes in ~1.8s alone but crosses the 5s default under
    // full-suite CPU contention on the win32 runner (a slow-machine timeout, not a hang).
  }, 20_000);
});
