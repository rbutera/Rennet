// @vitest-environment happy-dom
//
// C13 Cluster 5 — the S8 regression positive control at the HOOK level. registry.test.ts
// proves the pure factory throws on a duplicate id; this proves the guard fires through the
// real `useCoachAnchor` hook + provider, exactly as a duplicated anchor in a surface would:
// two live elements claiming one MarkId. The broken spike declared `data-tour="new-chat"`
// twice and let the first win silently — here the second registration is a loud throw.
//
// It is a POSITIVE CONTROL: run against a temporarily weakened guard (the throw removed from
// createCoachRegistry) it goes RED, so a green run proves the check can actually fail rather
// than passing vacuously.
import { Component, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { cleanup, mount, waitFor } from "../test/dom";
import { settingsBridge } from "../test/fixtures/settings";
import { CoachDataProvider } from "./provider";
import { useCoachAnchor } from "./registry";

/** Captures the commit-phase throw the duplicate registration raises. */
class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override render(): ReactNode {
    if (this.state.error) return <span data-testid="boundary">{this.state.error.message}</span>;
    return this.props.children;
  }
}

/** Two live elements both claim `new-chat` — the second registration must throw. */
function DuplicateAnchors() {
  const first = useCoachAnchor("new-chat");
  const second = useCoachAnchor("new-chat");
  return (
    <>
      <button type="button" ref={first}>
        one
      </button>
      <button type="button" ref={second}>
        two
      </button>
    </>
  );
}

describe("duplicate anchor for one MarkId is caught (C13 Cluster 5 · S8 positive control)", () => {
  it("throws /already registered/ when two live elements claim the same mark", async () => {
    const { getByTestId } = mount(
      <Catch>
        <BridgeProvider bridge={settingsBridge()}>
          <CoachDataProvider>
            <DuplicateAnchors />
          </CoachDataProvider>
        </BridgeProvider>
      </Catch>,
    );
    // The provider mounts once settings.get resolves; both refs then fire in one commit and
    // the second registration throws, surfacing through the boundary.
    await waitFor(() => expect(getByTestId("boundary").textContent).toMatch(/already registered/));
    cleanup();
  });
});
