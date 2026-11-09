// @vitest-environment happy-dom

import type {
  CommandInput,
  CommandName,
  CommandOutput,
  DetectedSourceControlTool,
  RennetBridge,
  ToolInstallProgressEvent,
} from "@rennet/protocol";
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

  it("shows the command it is running WHILE it runs, not only after", async () => {
    const held = heldInstall();
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
      </BridgeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));
    const call = held.calls[0];
    if (!call) throw new Error("no install dispatched");
    // The daemon says the command first, with no output yet.
    act(() =>
      held.bridge.emitToolInstallProgress(call.commandId, {
        kind: "tool-install-output",
        tool: "git-lfs",
        stream: "stdout",
        chunk: "",
        command: "brew install git-lfs && git lfs install",
      }),
    );
    expect(view()?.getAttribute("data-phase")).toBe("running");
    expect(document.querySelector('[data-slot="install-command"]')?.textContent).toBe(
      "brew install git-lfs && git lfs install",
    );
  });

  it("finishes for the owner that started it, even after the button moved to another owner", async () => {
    // The workspace is not keyed by session: one Install for me can show session A, then B.
    // A's install landing must run A's continuation — never B's — and B starts idle.
    const held = heldInstall();
    const ran: string[] = [];
    const button = (owner: string) => (
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe
          tool="git-lfs"
          locus={{ kind: "host" }}
          owner={owner}
          onInstalled={() => ran.push(owner)}
        />
      </BridgeProvider>
    );
    const { user, rerender } = mount(button("session-a"));
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));

    rerender(button("session-b"));
    expect(view()?.getAttribute("data-phase")).toBe("idle");

    held.settle({
      status: "installed",
      command: "brew install git-lfs && git lfs install",
      output: "",
      probe: probe("available"),
    });
    await waitFor(() => expect(ran).toEqual(["session-a"]));
    // B never ran an install, so it still offers one.
    expect(view()?.getAttribute("data-phase")).toBe("idle");

    // Back on A: its verdict is still there.
    rerender(button("session-a"));
    expect(view()?.getAttribute("data-phase")).toBe("installed");
  });

  it("runs the continuation bound when the install started, not a later one", async () => {
    const held = heldInstall();
    const ran: string[] = [];
    const button = (label: string) => (
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe
          tool="git-lfs"
          locus={{ kind: "host" }}
          owner="session-a"
          onInstalled={() => ran.push(label)}
        />
      </BridgeProvider>
    );
    const { user, rerender } = mount(button("first"));
    await user.click(screen.getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(held.calls).toHaveLength(1));
    rerender(button("second"));
    held.settle({
      status: "installed",
      command: "brew install git-lfs && git lfs install",
      output: "",
      probe: probe("available"),
    });
    await waitFor(() => expect(ran).toEqual(["first"]));
  });

  describe("across a dropped connection", () => {
    it("keeps the install running, keeps its output, and settles from a re-probe on reconnect", async () => {
      const flaky = new FlakyBridge();
      flaky.probe = probe("available");
      const installed: unknown[] = [];
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe
            tool="git-lfs"
            locus={{ kind: "host" }}
            onInstalled={(result) => installed.push(result)}
          />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      const commandId = flaky.installs[0]?.commandId ?? "";
      act(() => flaky.emit(commandId, "==> Pouring git-lfs\n"));

      act(() => flaky.drop());
      // Not "Rennet couldn't start the install": the installer is still going on the daemon.
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("reconnecting"));
      expect(view()?.getAttribute("data-phase")).toBe("running");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      // The subscription survived: output that streams meanwhile still lands.
      act(() => flaky.emit(commandId, "==> Summary\n"));
      const log = document.querySelector('[data-slot="install-output"]');
      expect(log?.textContent).toContain("Pouring git-lfs");
      expect(log?.textContent).toContain("Summary");

      act(() => flaky.reconnect());
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("installed"), {
        timeout: 4_000,
      });
      expect(installed).toHaveLength(1);
      // Settled from the re-probe: no second install was started.
      expect(flaky.installs).toHaveLength(1);
    });

    it("re-joins the daemon's run by its commandId when the tool is not there yet", async () => {
      const flaky = new FlakyBridge();
      flaky.probe = probe("not-installed");
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      act(() => flaky.drop());
      act(() => flaky.reconnect());
      await waitFor(() => expect(flaky.installs).toHaveLength(2), { timeout: 4_000 });
      expect(flaky.installs[1]?.commandId).toBe(flaky.installs[0]?.commandId);
      expect(view()?.getAttribute("data-phase")).toBe("running");

      act(() =>
        flaky.settle({
          status: "failed",
          command: "brew install git-lfs && git lfs install",
          message: "Homebrew couldn't install Git LFS.",
          failedCommand: "brew install git-lfs",
          exitCode: 1,
          output: "",
          probe: probe("not-installed"),
        }),
      );
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("failed"));
      expect(view()?.textContent).toContain("Homebrew couldn't install Git LFS.");
    });
  });
});

/**
 * A bridge whose connection can drop and come back, the way the connection supervisor's
 * does: in-flight commands reject with a `ConnectionError`, commands while it is down are
 * refused the same way, and progress subscriptions stay registered across it (the
 * supervisor re-attaches them to the fresh socket).
 */
class FlakyBridge implements Pick<RennetBridge, "invoke" | "onToolInstallProgress"> {
  readonly installs: InstallInput[] = [];
  probe: DetectedSourceControlTool = probe("not-installed");
  #online = true;
  readonly #pending = new Set<(reason: unknown) => void>();
  #release: ((result: InstallResult) => void) | undefined;
  readonly #listeners = new Map<string, Set<(event: ToolInstallProgressEvent) => void>>();

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    if (!this.#online) return Promise.reject(connectionLost());
    return new Promise((resolve, reject) => {
      this.#pending.add(reject);
      const done = (value: unknown) => {
        this.#pending.delete(reject);
        resolve(value as CommandOutput<K>);
      };
      if (name === "tools.install") {
        this.installs.push(input as InstallInput);
        this.#release = (result) => done({ result });
      } else if (name === "forge.hosts") {
        done({
          hosts: [{ source: "local", asked: true, detected: [], sourceControl: [this.probe] }],
        });
      } else if (name === "tools.cancelInstall") {
        done({ cancelled: true });
      } else {
        reject(new Error(`FlakyBridge: no handler for ${name}`));
      }
    });
  }

  onToolInstallProgress(
    commandId: string,
    listener: (event: ToolInstallProgressEvent) => void,
  ): () => void {
    const set = this.#listeners.get(commandId) ?? new Set();
    set.add(listener);
    this.#listeners.set(commandId, set);
    return () => set.delete(listener);
  }

  emit(commandId: string, chunk: string): void {
    for (const listener of this.#listeners.get(commandId) ?? []) {
      listener({ kind: "tool-install-output", tool: "git-lfs", stream: "stdout", chunk });
    }
  }

  drop(): void {
    this.#online = false;
    for (const reject of [...this.#pending]) reject(connectionLost());
    this.#pending.clear();
  }

  reconnect(): void {
    this.#online = true;
  }

  settle(result: InstallResult): void {
    this.#release?.(result);
  }
}

function connectionLost(): Error {
  return Object.assign(new Error("connection lost"), { name: "ConnectionError" });
}
