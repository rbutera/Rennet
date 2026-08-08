// @vitest-environment happy-dom
//
// The #58 harness-run consent gate, routed through the #103 permission mode.
// Mounts the whole `RennetApp` over a fake `RennetBridge` that records every
// command, opens the Canvases view, and asserts the harness command
// (`review.canvases`) does NOT run until the mode permits it:
//   - manual: no harness run on Canvases-open; a consent affordance appears; a
//     consent click then runs it.
//   - auto:   the harness runs on Canvases-open with no consent affordance.
// The assertions are behavioural (was the command invoked?), never presence-only.
import type { PermissionMode, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
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

/** A bridge that records every command name and serves the given workspace mode. */
function recordingBridge(mode: PermissionMode): { bridge: RennetBridge; calls: string[] } {
  const calls: string[] = [];
  const invoke = async (name: string): Promise<unknown> => {
    calls.push(name);
    if (name === "settings.permissionMode") return { mode };
    if (name === "settings.setPermissionMode") return { mode: "auto" };
    // The renderer requests approval; MAIN mints the single-use token (bead
    // workspace-fyvxb). The fake returns one so the consent click can relay it.
    if (name === "harness.requestConsent") return { authorization: "auth-token-under-test" };
    if (name === "review.canvases") return { canvases: demoCanvases(), elementDiffs: {} };
    return { review };
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"] }, calls };
}

const canvasesRun = (calls: string[]): number =>
  calls.filter((name) => name === "review.canvases").length;

describe("RennetApp — the harness-run consent gate (issue #58 / #103)", () => {
  it("MANUAL: opening Canvases does not run the harness until the user consents", async () => {
    const { bridge, calls } = recordingBridge("manual");
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    // The review loads.
    await waitFor(() => expect(container.querySelector(".view-toggle")).not.toBeNull());

    // Open Canvases. The consent affordance appears (the gate engaged)…
    fireEvent.click(getByRole("tab", { name: "Canvases" }));
    await waitFor(() => expect(container.querySelector(".harness-consent")).not.toBeNull());

    // …and NO harness turn has run. RED-proof: delete the `awaitingHarnessConsent`
    // early-return from the canvases effect → `review.canvases` fires on open →
    // this expectation fails.
    expect(canvasesRun(calls)).toBe(0);

    // Consent runs the harness and dismisses the affordance.
    const run = container.querySelector<HTMLButtonElement>(".harness-consent-run");
    if (!run) throw new Error("the consent run control did not render");
    fireEvent.click(run);
    await waitFor(() => {
      expect(canvasesRun(calls)).toBe(1);
      expect(container.querySelector(".harness-consent")).toBeNull();
    });
  });

  it("AUTO: opening Canvases runs the harness immediately with no consent affordance", async () => {
    const { bridge, calls } = recordingBridge("auto");
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    await waitFor(() => expect(container.querySelector(".view-toggle")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Canvases" }));

    // RED-proof: make `requiresConsent` always true (or gate `auto` too) → the
    // harness never runs on open → this never satisfies.
    await waitFor(() => expect(canvasesRun(calls)).toBe(1));
    expect(container.querySelector(".harness-consent")).toBeNull();
  });

  it("MANUAL → Always automatically: persists auto and runs the harness", async () => {
    const { bridge, calls } = recordingBridge("manual");
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    await waitFor(() => expect(container.querySelector(".view-toggle")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Canvases" }));
    await waitFor(() => expect(container.querySelector(".harness-consent")).not.toBeNull());

    const always = container.querySelector<HTMLButtonElement>(".harness-consent-auto");
    if (!always) throw new Error("the always-auto control did not render");
    fireEvent.click(always);

    // It persists the workspace default AND runs this review's harness.
    await waitFor(() => {
      expect(calls).toContain("settings.setPermissionMode");
      expect(canvasesRun(calls)).toBe(1);
      expect(container.querySelector(".harness-consent")).toBeNull();
    });
  });
});
