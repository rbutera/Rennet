// @vitest-environment happy-dom

import type {
  CommandInput,
  CommandName,
  CommandOutput,
  DetectedSourceControlTool,
  RennetBridge,
  ToolInstallProgressEvent,
  ToolInstallResult,
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
type InstallResult = ToolInstallResult;

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
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
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
    // The first press is a fresh request, never a rejoin.
    expect(call.rejoin).toBeUndefined();
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
    const { user } = mount(
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
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

  it("keeps an install with the owner that started it, even after the button moved to another owner", async () => {
    // The workspace is not keyed by session: one Install for me can show session A, then B.
    // A's install stays A's — its verdict is A's to show — and B starts idle.
    const held = heldInstall();
    const button = (owner: string) => (
      <BridgeProvider bridge={held.bridge}>
        <InstallForMe tool="git-lfs" locus={{ kind: "host" }} owner={owner} />
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
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    // B never ran an install, so it still offers one.
    expect(view()?.getAttribute("data-phase")).toBe("idle");

    // Back on A: its verdict is still there.
    rerender(button("session-a"));
    expect(view()?.getAttribute("data-phase")).toBe("installed");
  });

  describe("across a dropped connection", () => {
    it("keeps the install running, keeps its output, and settles from the daemon's verdict on reconnect", async () => {
      const flaky = new FlakyBridge();
      flaky.probe = probe("available");
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
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
      // The SAME request goes back to the daemon as a rejoin: it answers with that run's
      // verdict (a run that finished meanwhile answers from the verdict it kept).
      await waitFor(() => expect(flaky.installs).toHaveLength(2), { timeout: 4_000 });
      expect(flaky.installs[1]?.commandId).toBe(commandId);
      expect(flaky.installs[1]?.rejoin).toBe(true);
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).not.toContain("reconnecting"),
      );
      act(() =>
        flaky.settle({
          status: "installed",
          command: "brew install git-lfs && git lfs install",
          output: "==> Pouring git-lfs\n==> Summary\n",
          probe: probe("available"),
        }),
      );
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("installed"));
    });

    it("never reads a probe that finds the binary as installed: an init that failed is a failure", async () => {
      // `git lfs version` answers as soon as Homebrew has poured the bottle, while `git lfs
      // install` may still be running — or fail. Seeing the binary is not the verdict.
      const flaky = new FlakyBridge();
      flaky.probe = probe("available");
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
      // Still running, Cancel and all: nothing was concluded from the probe.
      expect(view()?.getAttribute("data-phase")).toBe("running");

      act(() =>
        flaky.settle({
          status: "failed",
          command: "brew install git-lfs && git lfs install",
          message: "Git LFS couldn't be set up.",
          failedCommand: "git lfs install",
          exitCode: 2,
          output: "error: could not write config",
          probe: probe("available"),
        }),
      );
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("failed"));
      expect(view()?.textContent).toContain("Git LFS couldn't be set up.");
    });

    it("sends a Cancel pressed while disconnected once the connection is back, and never asks to install again", async () => {
      const flaky = new FlakyBridge();
      flaky.probe = probe("not-installed");
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      const commandId = flaky.installs[0]?.commandId ?? "";

      act(() => flaky.drop());
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Stopping"));
      expect(flaky.cancels).toEqual([]);

      // The installer is still running on the daemon when the connection comes back.
      act(() => flaky.reconnect());
      await waitFor(() => expect(flaky.cancels).toEqual([commandId]), { timeout: 4_000 });
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("failed"));
      expect(view()?.textContent).toContain("The Git LFS install was stopped.");
      // The cancel went through instead of a second request to install.
      expect(flaky.installs).toHaveLength(1);
    });

    it("settles a late Cancel from the verdict of an install that had already finished", async () => {
      const flaky = new FlakyBridge();
      flaky.cancelAnswer = {
        cancelled: false,
        result: {
          status: "installed",
          command: "brew install git-lfs && git lfs install",
          output: "",
          probe: probe("available"),
        },
      };
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      act(() => flaky.drop());
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => flaky.reconnect());
      // What happened is what it says: the install had finished before the cancel arrived.
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("installed"), {
        timeout: 4_000,
      });
      expect(flaky.installs).toHaveLength(1);
    });

    it("replaces the drawer with the daemon's snapshot when the run is re-joined", async () => {
      const flaky = new FlakyBridge();
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      const commandId = flaky.installs[0]?.commandId ?? "";
      act(() => flaky.emit(commandId, "==> Downloading\n"));
      act(() => flaky.drop());
      act(() => flaky.reconnect());
      await waitFor(() => expect(flaky.installs).toHaveLength(2), { timeout: 4_000 });
      // The re-join's snapshot carries everything so far — including what streamed while the
      // connection was down — and replaces the drawer rather than following it.
      act(() => flaky.emit(commandId, "==> Downloading\n==> Pouring git-lfs\n", true));
      act(() => flaky.emit(commandId, "==> Summary\n"));
      const log = document.querySelector('[data-slot="install-output"]');
      expect(log?.textContent).toBe("==> Downloading\n==> Pouring git-lfs\n==> Summary\n");
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

    it("says it lost track when the daemon knows nothing of the install on reconnect, and installs nothing", async () => {
      // The daemon restarted (or the verdict aged out) while the connection was down. The
      // rejoin answers unknown; the install must NOT be asked for again under any id.
      const flaky = new FlakyBridge();
      flaky.forgetsOnRejoin = true;
      flaky.probe = probe("available");
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      const commandId = flaky.installs[0]?.commandId ?? "";
      act(() => flaky.emit(commandId, "==> Pouring git-lfs\n"));
      act(() => flaky.drop());
      act(() => flaky.reconnect());

      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("lost"), {
        timeout: 4_000,
      });
      expect(view()?.textContent).toContain("Rennet lost track of the Git LFS install.");
      // The one ask after the reconnect was a rejoin of the same id; nothing else went out.
      expect(flaky.installs).toHaveLength(2);
      expect(flaky.installs[1]).toMatchObject({ commandId, rejoin: true });
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(flaky.installs.filter((call) => call.rejoin !== true)).toHaveLength(1);

      // Check again shows what is there, and decides nothing: still lost, still no install.
      await user.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() =>
        expect(document.querySelector('[data-slot="lost-check"]')?.textContent).toBe(
          "Git LFS answers on this machine (3.6.1).",
        ),
      );
      expect(view()?.getAttribute("data-phase")).toBe("lost");
      expect(flaky.installs).toHaveLength(2);

      // Install for me is a fresh press: a NEW command id, not a rejoin.
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(3));
      expect(flaky.installs[2]?.commandId).not.toBe(commandId);
      expect(flaky.installs[2]?.rejoin).toBeUndefined();
      expect(view()?.getAttribute("data-phase")).toBe("running");
    });

    it("says it lost track, not that it stopped, when a late Cancel finds the daemon knows nothing", async () => {
      const flaky = new FlakyBridge();
      flaky.cancelAnswer = { cancelled: false };
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      act(() => flaky.drop());
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => flaky.reconnect());
      await waitFor(() => expect(view()?.getAttribute("data-phase")).toBe("lost"), {
        timeout: 4_000,
      });
      expect(view()?.textContent).not.toContain("was stopped");
      expect(flaky.installs).toHaveLength(1);
    });

    it("re-offers Cancel when the daemon refuses the reconnect's cancel, as a direct Cancel does", async () => {
      const flaky = new FlakyBridge();
      flaky.cancelRefusal = new Error("acme refused");
      const { user } = mount(
        <BridgeProvider bridge={flaky}>
          <InstallForMe tool="git-lfs" locus={{ kind: "host" }} />
        </BridgeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Install for me" }));
      await waitFor(() => expect(flaky.installs).toHaveLength(1));
      act(() => flaky.drop());
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => flaky.reconnect());
      // Still running — not "unavailable" — with Cancel offered again, and the run re-joined.
      await waitFor(() => expect(flaky.installs).toHaveLength(2), { timeout: 4_000 });
      expect(flaky.installs[1]?.rejoin).toBe(true);
      expect(view()?.getAttribute("data-phase")).toBe("running");
      const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
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
  readonly cancels: string[] = [];
  probe: DetectedSourceControlTool = probe("not-installed");
  /** What `tools.cancelInstall` answers: by default, the daemon stopped a running install. */
  cancelAnswer: CommandOutput<"tools.cancelInstall"> = { cancelled: true };
  /** `tools.cancelInstall` is refused outright (not a dropped connection). */
  cancelRefusal: Error | undefined;
  /** A rejoin finds a daemon that knows nothing of the id (it restarted). */
  forgetsOnRejoin = false;
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
        if (this.forgetsOnRejoin && (input as InstallInput).rejoin === true) {
          done({ outcome: "unknown" });
          return;
        }
        this.#release = (result) => done({ result });
      } else if (name === "forge.hosts") {
        done({
          hosts: [{ source: "local", asked: true, detected: [], sourceControl: [this.probe] }],
        });
      } else if (name === "tools.cancelInstall") {
        this.cancels.push((input as CommandInput<"tools.cancelInstall">).commandId);
        if (this.cancelRefusal !== undefined) {
          this.#pending.delete(reject);
          reject(this.cancelRefusal);
          return;
        }
        done(this.cancelAnswer);
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

  emit(commandId: string, chunk: string, replace?: true): void {
    for (const listener of this.#listeners.get(commandId) ?? []) {
      listener({
        kind: "tool-install-output",
        tool: "git-lfs",
        stream: "stdout",
        chunk,
        ...(replace === undefined ? {} : { replace }),
      });
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
