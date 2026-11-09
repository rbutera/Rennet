// @vitest-environment happy-dom

import type { CommandInput, CommandOutput, DetectedSourceControlTool } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { act, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { InstallForMe } from "./install-for-me";

// Install for me (source-control-tooling spec), driven through the real data seam over a
// MemoryBridge whose `tools.install` answer is HELD until the test releases it — which is
// the only way to see the running state, the streamed chunks and Cancel at all. A handler
// that answered at once would pass every "while it runs" assertion vacuously.

type InstallInput = CommandInput<"tools.install">;
type InstallResult = CommandOutput<"tools.install">["result"];

const probe = (status: DetectedSourceControlTool["status"]): DetectedSourceControlTool => ({
  id: "git-lfs",
  version: status === "available" ? "3.6.1" : null,
  status,
  detail: status === "available" ? "Git LFS 3.6.1" : "Git LFS is not installed.",
});

function heldInstall() {
  const calls: InstallInput[] = [];
  const cancels: string[] = [];
  let release: ((result: InstallResult) => void) | undefined;
  const bridge = new MemoryBridge({
    "tools.install": (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        release = (result) => resolve({ result });
      });
    },
    "tools.cancelInstall": ({ commandId }) => {
      cancels.push(commandId);
      return { cancelled: true };
    },
  });
  return {
    bridge,
    calls,
    cancels,
    settle(result: InstallResult) {
      if (!release) throw new Error("no install is running");
      act(() => release?.(result));
    },
  };
}

const view = () => document.querySelector('[data-kind="install-for-me"]');

describe("Install for me", () => {
  it("streams the installer's output while it runs, then reports the re-probe", async () => {
    const held = heldInstall();
    const installed: unknown[] = [];
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe
          tool="git-lfs"
          locus={{ kind: "host" }}
          onInstalled={(result) => installed.push(result)}
        />
      </BridgeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));
    const call = held.calls[0];
    if (!call) throw new Error("no install dispatched");
    expect(call).toMatchObject({ tool: "git-lfs", locus: { kind: "host" } });
    expect(view()?.getAttribute("data-phase")).toBe("running");
    expect(screen.getByRole("status").textContent).toContain("Installing Git LFS");

    // Chunks keyed to THIS install's commandId land in the open drawer; another command's
    // chunk does not. The second assertion is what makes the first one mean "keyed".
    act(() => {
      held.bridge.emitToolInstallProgress(call.commandId, {
        kind: "tool-install-output",
        tool: "git-lfs",
        stream: "stdout",
        chunk: "==> Pouring git-lfs--3.6.1\n",
      });
      held.bridge.emitToolInstallProgress("someone-else", {
        kind: "tool-install-output",
        tool: "git-lfs",
        stream: "stdout",
        chunk: "NOT THIS INSTALL",
      });
    });
    const log = document.querySelector('[data-slot="install-output"]');
    expect(log?.textContent).toContain("Pouring git-lfs");
    expect(log?.textContent).not.toContain("NOT THIS INSTALL");

    held.settle({
      status: "installed",
      command: "brew install git-lfs && git lfs install",
      output: "==> Pouring git-lfs--3.6.1\nGit LFS initialized.\n",
      probe: probe("available"),
    });

    await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("installed"));
    expect(view()?.textContent).toContain("Git LFS is installed");
    expect(view()?.textContent).toContain("3.6.1");
    expect(document.querySelector('[data-slot="install-command"]')?.textContent).toBe(
      "brew install git-lfs && git lfs install",
    );
    expect(installed).toHaveLength(1);
  });

  it("cancels the running install by its own commandId", async () => {
    const held = heldInstall();
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
      </BridgeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(held.cancels).toEqual([held.calls[0]?.commandId]));

    held.settle({
      status: "failed",
      command: "brew install git-lfs && git lfs install",
      message: "The install was cancelled.",
      failedCommand: "brew install git-lfs",
      exitCode: null,
      cancelled: true,
      output: "==> Downloading",
      probe: probe("not-installed"),
    });
    await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("failed"));
    expect(screen.getByRole("alert").textContent).toBe("The Git LFS install was stopped.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says a failure plainly and keeps the installer's output behind the drawer", async () => {
    const held = heldInstall();
    const installed: unknown[] = [];
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe
          tool="git-lfs"
          locus={{ kind: "host" }}
          onInstalled={(result) => installed.push(result)}
        />
      </BridgeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));
    held.settle({
      status: "failed",
      command: "brew install git-lfs && git lfs install",
      message: "Homebrew couldn't install Git LFS.",
      failedCommand: "brew install git-lfs",
      exitCode: 1,
      output: "Error: No such keg: /opt/homebrew/Cellar/git-lfs",
      probe: probe("not-installed"),
    });

    await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("failed"));
    expect(screen.getByRole("alert").textContent).toBe("Homebrew couldn't install Git LFS.");
    expect(view()?.textContent).toContain("exited with code 1");
    // The raw output is folded away until asked for.
    expect(document.querySelector('[data-slot="install-output"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show output" }));
    expect(document.querySelector('[data-slot="install-output"]')?.textContent).toContain(
      "No such keg",
    );
    // A failed install never reports itself installed to the parent.
    expect(installed).toEqual([]);
  });

  it("shows the manual command and a docs link instead of running anything", async () => {
    const held = heldInstall();
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "wsl", distro: "Ubuntu" }} />
      </BridgeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));
    expect(held.calls[0]?.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    held.settle({
      status: "manual",
      command: "sudo apt install git-lfs",
      docsUrl: "https://git-lfs.com",
      probe: probe("not-installed"),
    });

    await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("manual"));
    expect(screen.queryByRole("button", { name: "Install for me" })).toBeNull();
    expect(document.querySelector('[data-slot="install-command"]')?.textContent).toBe(
      "sudo apt install git-lfs",
    );
    expect(screen.getByRole("button", { name: "Copy sudo apt install git-lfs" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Git LFS install instructions/ }).getAttribute("href"),
    ).toBe("https://git-lfs.com");
  });
});
