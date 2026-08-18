// @vitest-environment happy-dom
//
// The GitHub connect surfaces (v4.2, wireframes 01 + 15): the SKIPPABLE first-run
// card and the settings account rows, over a recording fake bridge. Behavioural:
// the card's skip persists, connect runs the device-flow code → poll → connected
// journey, the paste side door validates before celebrating, disconnect forgets.
import type { GitHubAuthStatus, GitHubConnectPoll, RennetBridge } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { GitHubAccountRows, GitHubConnectCard } from "./github-connect";

const NOT_CONNECTED: GitHubAuthStatus = {
  state: "not-connected",
  copy: "GitHub is not connected.",
};
const CONNECTED: GitHubAuthStatus = {
  state: "connected",
  login: "rbutera",
  scopes: ["repo", "workflow"],
};

interface FakeConfig {
  status?: GitHubAuthStatus;
  polls?: GitHubConnectPoll[];
  setTokenStatus?: GitHubAuthStatus;
}

function fakeBridge(config: FakeConfig = {}) {
  const calls: { name: string; input: unknown }[] = [];
  let status = config.status ?? NOT_CONNECTED;
  const polls = [...(config.polls ?? [])];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "github.status":
        return { status };
      case "github.connectStart":
        return {
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresIn: 900,
          interval: 5,
        };
      case "github.connectPoll": {
        const next = polls.shift() ?? { phase: "pending" };
        if (next.phase === "connected") status = next.status;
        return { poll: next };
      }
      case "github.setToken": {
        const result = config.setTokenStatus ?? CONNECTED;
        if (result.state === "connected") status = result;
        return { status: result };
      }
      case "github.disconnect":
        status = NOT_CONNECTED;
        return {};
      default:
        return {};
    }
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] } as RennetBridge,
    calls,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("GitHubConnectCard — skippable, never a wall (wireframe 01)", () => {
  it("renders the card when not connected, with Connect and Skip", async () => {
    const { bridge } = fakeBridge();
    const { container } = mount(<GitHubConnectCard bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".github-card")).not.toBeNull());
    expect(container.querySelector(".github-card-title")?.textContent).toBe("Connect GitHub");
    expect(container.querySelector(".github-skip")?.textContent).toBe("Skip for now");
  });

  it("renders NOTHING when already connected — no nag", async () => {
    const { bridge, calls } = fakeBridge({ status: CONNECTED });
    const { container } = mount(<GitHubConnectCard bridge={bridge} />);
    await waitFor(() => expect(calls.some((c) => c.name === "github.status")).toBe(true));
    expect(container.querySelector(".github-card")).toBeNull();
  });

  it("skip dismisses the card and REMEMBERS on this machine", async () => {
    const first = fakeBridge();
    const mounted = mount(<GitHubConnectCard bridge={first.bridge} />);
    await waitFor(() => expect(mounted.container.querySelector(".github-skip")).not.toBeNull());
    const skip = mounted.container.querySelector(".github-skip");
    if (!skip) throw new Error("skip button missing");
    fireEvent.click(skip);
    expect(mounted.container.querySelector(".github-card")).toBeNull();

    // A remount (next launch) stays dismissed — the permanent home is Settings.
    const second = fakeBridge();
    const remounted = mount(<GitHubConnectCard bridge={second.bridge} />);
    await waitFor(() => expect(second.calls.some((c) => c.name === "github.status")).toBe(true));
    expect(remounted.container.querySelector(".github-card")).toBeNull();
  });

  it("connect shows the one-time code + verification link, then polls to connected", async () => {
    vi.useFakeTimers();
    const { bridge, calls } = fakeBridge({
      polls: [{ phase: "pending" }, { phase: "connected", status: CONNECTED }],
    });
    const { container } = mount(<GitHubConnectCard bridge={bridge} />);
    await vi.waitFor(() => expect(container.querySelector(".github-btn")).not.toBeNull());
    const connect = container.querySelector(".github-btn");
    if (!connect) throw new Error("connect button missing");
    fireEvent.click(connect);
    await vi.waitFor(() => expect(container.querySelector(".github-code")).not.toBeNull());
    expect(container.querySelector(".github-code")?.textContent).toBe("ABCD-1234");
    expect(container.querySelector(".github-flow-hint a")?.getAttribute("href")).toBe(
      "https://github.com/login/device",
    );

    // Two poll ticks: pending, then connected — the card retires itself.
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(container.querySelector(".github-card")).toBeNull());
    expect(calls.filter((c) => c.name === "github.connectPoll").length).toBeGreaterThanOrEqual(2);
  });
});

describe("GitHubAccountRows — the settings rows (wireframe 15)", () => {
  it("shows connected-as fact and Disconnect; disconnect forgets and re-reads", async () => {
    const { bridge, calls } = fakeBridge({ status: CONNECTED });
    const { container } = mount(<GitHubAccountRows bridge={bridge} />);
    await waitFor(() =>
      expect(container.querySelector(".github-connected")?.textContent).toContain("@rbutera"),
    );
    const disconnect = [...container.querySelectorAll(".github-btn")].find(
      (button) => button.textContent === "Disconnect",
    );
    if (!disconnect) throw new Error("disconnect button missing");
    fireEvent.click(disconnect);
    await waitFor(() => expect(calls.some((c) => c.name === "github.disconnect")).toBe(true));
    await waitFor(() => expect(container.querySelector(".github-connected")).toBeNull());
  });

  it("paste side door: a GOOD token stores and reads connected", async () => {
    const { bridge, calls } = fakeBridge({ status: NOT_CONNECTED });
    const { container } = mount(<GitHubAccountRows bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".github-token-input")).not.toBeNull());
    const input = container.querySelector(".github-token-input");
    if (!input) throw new Error("token input missing");
    fireEvent.input(input, { target: { value: "ghp_good" } });
    const save = [...container.querySelectorAll(".github-btn")].find(
      (button) => button.textContent === "Save",
    );
    if (!save) throw new Error("save button missing");
    fireEvent.click(save);
    await waitFor(() =>
      expect(container.querySelector(".github-connected")?.textContent).toContain("@rbutera"),
    );
    const setToken = calls.find((c) => c.name === "github.setToken");
    expect(setToken?.input).toEqual({ token: "ghp_good" });
  });

  it("paste side door: a BAD token surfaces its distinct copy, stores nothing", async () => {
    const { bridge } = fakeBridge({
      status: NOT_CONNECTED,
      setTokenStatus: { state: "token-invalid", copy: "The stored GitHub token was revoked." },
    });
    const { container } = mount(<GitHubAccountRows bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".github-token-input")).not.toBeNull());
    const input = container.querySelector(".github-token-input");
    if (!input) throw new Error("token input missing");
    fireEvent.input(input, { target: { value: "ghp_typo" } });
    const save = [...container.querySelectorAll(".github-btn")].find(
      (button) => button.textContent === "Save",
    );
    if (!save) throw new Error("save button missing");
    fireEvent.click(save);
    await waitFor(() =>
      expect(container.querySelector(".github-error")?.textContent).toContain("revoked"),
    );
    expect(container.querySelector(".github-connected")).toBeNull();
  });

  it("insufficient-scope renders its own copy as the row's problem, with Connect", async () => {
    const { bridge } = fakeBridge({
      status: { state: "insufficient-scope", copy: "This token is missing `repo`.", scopes: [] },
    });
    const { container } = mount(<GitHubAccountRows bridge={bridge} />);
    await waitFor(() =>
      expect(container.querySelector(".github-problem")?.textContent).toContain("missing"),
    );
    expect(
      [...container.querySelectorAll(".github-btn")].some(
        (button) => button.textContent === "Connect",
      ),
    ).toBe(true);
  });
});
