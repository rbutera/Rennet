// @vitest-environment happy-dom

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryHistory } from "../routes/history";
import { mount, waitFor } from "../test/dom";
import { PriorSurfaceTracker, usePriorSurface } from "./prior-surface";

function Probe() {
  const [, navigate] = useLocation();
  const priorSurface = usePriorSurface();
  const [readout, setReadout] = useState("");
  return (
    <>
      <button type="button" onClick={() => navigate("/new-chat?project=p1")}>
        Open New Chat
      </button>
      <button type="button" onClick={() => setReadout(priorSurface())}>
        Read prior
      </button>
      <output>{readout}</output>
    </>
  );
}

describe("PriorSurfaceTracker", () => {
  it("keeps the prior review while New Chat is the active takeover", async () => {
    const history = memoryHistory("/s/session-1?view=diff");
    const { getByRole, user } = mount(
      <Router hook={history.hook} searchHook={history.searchHook}>
        <PriorSurfaceTracker>
          <Probe />
        </PriorSurfaceTracker>
      </Router>,
    );

    await user.click(getByRole("button", { name: "Open New Chat" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p1"));
    await user.click(getByRole("button", { name: "Read prior" }));

    expect(getByRole("status").textContent).toBe("/s/session-1?view=diff");
  });
});
