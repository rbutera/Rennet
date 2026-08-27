// @vitest-environment happy-dom
//
// C13 Cluster 3 — the coach persistence seam, proven from the app-ui side. The store is
// seeded from the persisted `coachmarks` slice `settings.get` carries, and every
// dismiss/skip/replay persists through `settings.setCoachmarks`. Data enters only through
// the bridge context (a stateful settings MemoryBridge) — no `bridge.invoke` in a
// component, no `localStorage`. Three proofs: a seeded skip-all suppresses election, an
// unseen mark elects once its anchor registers, and a dismiss persists (survives a reload,
// modelled as a remount over the SAME bridge).
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { cleanup, mount, waitFor } from "../test/dom";
import { SettingsStore } from "../test/fixtures/settings";
import { MemoryBridge } from "../test/memory-bridge";
import { useCoachOptional } from "./context";
import { CoachDataProvider } from "./provider";
import { useCoachAnchor } from "./registry";
import type { CoachStore } from "./store";

/**
 * A probe: registers `start-review`'s anchor (null-safe ref) and, behind the optional
 * context guard, prints the elected mark id and offers a dismiss button. The guard keeps
 * the store subscription out of the pre-provider window (mirrors the real Coachmark).
 */
function Probe() {
  const ref = useCoachAnchor("start-review");
  return (
    <div>
      <button type="button" ref={ref} data-testid="anchor">
        anchor
      </button>
      <Readout />
    </div>
  );
}

function Readout() {
  const coach = useCoachOptional();
  if (!coach) return <span data-testid="active">none</span>;
  return <ReadoutBody store={coach.store} />;
}

function ReadoutBody({ store }: { store: CoachStore }) {
  const active = store((s) => s.active);
  return (
    <>
      <span data-testid="active">{active ?? "none"}</span>
      <button
        type="button"
        data-testid="dismiss"
        onClick={() => store.getState().dismiss("start-review")}
      >
        dismiss
      </button>
    </>
  );
}

function bridgeWith(store: SettingsStore): MemoryBridge {
  return new MemoryBridge(store.handlers());
}

describe("coach persistence seam (C13 Cluster 3)", () => {
  it("elects the first unseen mark once its anchor registers (fresh install)", async () => {
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridgeWith(new SettingsStore())}>
        <CoachDataProvider>
          <Probe />
        </CoachDataProvider>
      </BridgeProvider>,
    );
    // Seeded empty, the registered mark elects — the store awaited settings.get first.
    await waitFor(() => expect(getByTestId("active").textContent).toBe("start-review"));
    cleanup();
  });

  it("a seeded skip-all suppresses election — nothing fires (reload survival)", async () => {
    const store = new SettingsStore({ coachmarks: { seen: [], skipAll: true } });
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridgeWith(store)}>
        <CoachDataProvider>
          <Probe />
        </CoachDataProvider>
      </BridgeProvider>,
    );
    // The anchor registers, but skip-all (seeded from settings.get) keeps active null.
    await waitFor(() => expect(getByTestId("anchor")).toBeTruthy());
    expect(getByTestId("active").textContent).toBe("none");
    cleanup();
  });

  it("a dismiss persists through settings.setCoachmarks and survives a remount", async () => {
    // One stateful bridge across two mounts models a reload: the write must still be there.
    const store = new SettingsStore();
    const bridge = bridgeWith(store);

    const first = mount(
      <BridgeProvider bridge={bridge}>
        <CoachDataProvider>
          <Probe />
        </CoachDataProvider>
      </BridgeProvider>,
    );
    await waitFor(() => expect(first.getByTestId("active").textContent).toBe("start-review"));
    // Dismiss the mark — persists { seen: [start-review] } through settings.setCoachmarks.
    await first.user.click(first.getByTestId("dismiss"));
    await waitFor(() => expect(first.getByTestId("active").textContent).toBe("none"));
    cleanup();

    // Remount over the SAME bridge: settings.get now carries the persisted seen mark, so
    // the store re-seeds from it and start-review never re-elects.
    const second = mount(
      <BridgeProvider bridge={bridge}>
        <CoachDataProvider>
          <Probe />
        </CoachDataProvider>
      </BridgeProvider>,
    );
    await waitFor(() => expect(second.getByTestId("anchor")).toBeTruthy());
    expect(second.getByTestId("active").textContent).toBe("none");
    cleanup();
  });
});
