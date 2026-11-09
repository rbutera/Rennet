// @vitest-environment happy-dom

import type {
  CommandInput,
  Review,
  SettingsView,
  SidebarSession,
  ToolInstallResult,
} from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount, screen, waitFor, within } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { LARGE_FILE_REMEMBERED } from "./large-file-choice";

// ─────────────────────────────────────────────────────────────────────────────
// THE STOPPED AND WAITING PREPARATION, driven through the real app (review-preparation-
// reliability tasks 3.3 and 3.4).
//
// Every test mounts `RennetRouterApp` over a MemoryBridge that RECORDS what each button
// dispatched, so "offers Install for me" is proved by the install the click started — with
// the locus the project's settings row names — not by a button merely existing. The
// project lives in a WSL distro for exactly that reason: a fixture on the host would pass
// over a component that hard-coded `{ kind: "host" }`.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW = {
  id: "rev-widget",
  repositoryRoot: "/home/dev/widget",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local", files: [] }],
} as unknown as Review;

type InstallResult = ToolInstallResult;

interface Recorded {
  readonly installs: CommandInput<"tools.install">[];
  readonly choices: CommandInput<"session.chooseLargeFileMode">[];
  readonly retries: CommandInput<"session.retryPreparation">[];
  cancels: number;
}

function surface(
  preparation: SidebarSession["preparation"],
  options: {
    readonly review?: boolean;
    readonly install?: InstallResult;
    /** Holds `tools.install` open until it resolves, so the running state can be seen. */
    readonly installGate?: Promise<void>;
    /** Holds `session.chooseLargeFileMode` open, so a pending answer can be seen. */
    readonly chooseGate?: Promise<void>;
    /** Holds `settings.get` — and so the project's machine — until it resolves or rejects. */
    readonly settingsGate?: Promise<void>;
    /** Whether the review is attached, read on every call: flip it to attach mid-question. */
    readonly attached?: { current: boolean };
    /** `session.retryPreparation` rejects, as a dropped connection would. */
    readonly retryFails?: boolean;
    /** `session.cancelPreparation` and `session.chooseLargeFileMode` reject the same way. */
    readonly writesFail?: boolean;
    readonly workspaceNotes?: readonly string[];
    /**
     * The session's preparation as the daemon holds it NOW, read on every call: Retry moves
     * it to capturing and Cancel to cancelled, as the daemon would, unless `cancelSticks` is
     * false (a cancel the daemon's read does not show yet). Set it by hand to stand for
     * another window acting on the session.
     */
    readonly live?: { current: SidebarSession["preparation"] };
    readonly cancelSticks?: boolean;
    /** Where the app opens, when not the session's board. */
    readonly path?: string;
  } = {},
) {
  const currentPreparation = () =>
    options.live === undefined ? preparation : options.live.current;
  const reviewAttached = () => options.attached?.current ?? options.review === true;
  const recorded: Recorded = { installs: [], choices: [], retries: [], cancels: 0 };
  const row = (): SidebarSession =>
    ({
      id: "sess-widget",
      projectId: "proj-widget",
      title: "feat/widget-lfs",
      target: "your-pr",
      createdAt: 0,
      claim: { branch: "feat/widget-lfs", prNumber: 7 },
      ...(reviewAttached() ? { reviewId: REVIEW.id } : {}),
      ...(currentPreparation() === undefined ? {} : { preparation: currentPreparation() }),
      ...(options.workspaceNotes === undefined
        ? {}
        : { workspaceNotes: [...options.workspaceNotes] }),
    }) as SidebarSession;
  const settings = {
    ...emptySettings(),
    projects: [{ projectId: "proj-widget", locus: { kind: "wsl", distro: "Ubuntu" } }],
  } as unknown as SettingsView;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": async () => {
      await options.settingsGate;
      return settings;
    },
    "forge.hosts": () => ({ hosts: [] }),
    "session.list": () => ({ sessions: [row()] }),
    "session.cancelPreparation": () => {
      recorded.cancels += 1;
      if (options.writesFail === true) throw new Error("connection lost");
      if (options.live !== undefined && options.cancelSticks !== false) {
        options.live.current = { status: "cancelled", stage: "workspace", reviewId: REVIEW.id };
      }
      return { session: row() };
    },
    "session.retryPreparation": (input: CommandInput<"session.retryPreparation">) => {
      recorded.retries.push(input);
      if (options.retryFails === true)
        throw Object.assign(new Error("connection lost"), {
          name: "ConnectionError",
        });
      if (options.live !== undefined) {
        options.live.current = { status: "capturing", step: "capturing-change" };
      }
      return { session: row() };
    },
    "session.chooseLargeFileMode": async (input: CommandInput<"session.chooseLargeFileMode">) => {
      recorded.choices.push(input);
      await options.chooseGate;
      if (options.writesFail === true) throw new Error("connection lost");
      return { session: row() };
    },
    "tools.install": async (input: CommandInput<"tools.install">) => {
      recorded.installs.push(input);
      await options.installGate;
      return {
        result: options.install ?? {
          status: "installed",
          command: "brew install git-lfs && git lfs install",
          output: "Git LFS initialized.",
          probe: { id: "git-lfs", version: "3.6.1", status: "available", detail: "" },
        },
      };
    },
    "review.load": (input: CommandInput<"review.load">) => {
      if (!reviewAttached() || input.reviewId !== REVIEW.id) throw new Error("Review not found");
      return { review: REVIEW, repositoryPresent: true };
    },
    "review.checkFreshness": () => ({ review: REVIEW }),
    "board.read": () => ({ board: null }),
    "chat.t3Session": () => ({
      origin: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1",
      accessToken: "t",
      environmentId: "env-1",
    }),
  } as never);
  const history = memoryHistory(options.path ?? "/s/sess-widget");
  const view = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return { ...view, recorded, history };
}

/**
 * The large-file dialog, found by the title that labels it — the app has other dialogs (a
 * coach mark is one), so "the first dialog" would be a guess. On a review route it is read
 * only once the review workspace has mounted: the route paints the preparing workspace for
 * the beat before `review.load` answers, and the dialog that frame opened is replaced.
 */
async function choiceDialog(name: string | RegExp = /large files/): Promise<HTMLElement> {
  if (document.querySelector('[data-kind="lens-board-view"]') === null) {
    await waitFor(() =>
      expect(document.querySelector('[data-kind="lens-board-view"]')).not.toBeNull(),
    );
  }
  return screen.findByRole("dialog", { name });
}

/** A promise the test resolves (or rejects) by hand. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve: () => act(() => resolve()), reject: (r: unknown) => reject(r) };
}

const block = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-testid="preparation-failure"]');
    if (!found) throw new Error("no failure block");
    return found;
  });

beforeEach(() => {
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, seatTranscript: null } }));
});

describe("a stopped preparation is one actionable block", () => {
  const lfsMissing: SidebarSession["preparation"] = {
    status: "failed",
    stage: "workspace",
    reason: "Git LFS is needed to check out this pull request.",
    kind: "tool-missing",
    action: "install",
    tool: "git-lfs",
    detail:
      "git-lfs filter-process --skip: git-lfs: command not found\nfatal: the remote end hung up",
    reviewId: REVIEW.id,
  };

  it("installs the missing tool where the project lives, then offers Retry and sends nothing itself", async () => {
    const { user, recorded } = surface(lfsMissing);
    const failure = await block();
    const retry = within(failure).getByRole("button", { name: "Retry" });
    // Before the install, Install for me is the way forward and Retry is secondary.
    expect(retry.getAttribute("data-emphasis")).toBe("secondary");
    await user.click(within(failure).getByRole("button", { name: "Install Git LFS for me" }));

    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    expect(recorded.installs[0]).toMatchObject({
      tool: "git-lfs",
      locus: { kind: "wsl", distro: "Ubuntu" },
    });
    await waitFor(() => expect(failure.textContent).toContain("Git LFS is installed"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
    // The install landed and sent NOTHING on the reviewer's behalf…
    expect(recorded.retries).toEqual([]);
    expect(recorded.choices).toEqual([]);
    // …and Retry is now the primary action, one click away.
    expect(retry.getAttribute("data-emphasis")).toBe("primary");
    await user.click(retry);
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
  });

  it("offers the install again when a Retry stops on the same missing tool", async () => {
    // The install answered the stop it was pressed for. When the review, retried, stops again
    // asking for Git LFS, that earlier "installed" is not an answer to this stop: kept, the
    // block said "Git LFS is installed" with no button, and Retry failed in a loop.
    const live: { current: SidebarSession["preparation"] } = { current: lfsMissing };
    const { user, recorded } = surface(lfsMissing, { live });
    const first = await block();
    await user.click(within(first).getByRole("button", { name: "Install Git LFS for me" }));
    await waitFor(() => expect(first.textContent).toContain("Git LFS is installed"));
    await user.click(within(first).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="preparation-failure"]')).toBeNull(),
    );

    live.current = lfsMissing;
    const again = await block();
    expect(again.textContent).not.toContain("Git LFS is installed");
    await user.click(within(again).getByRole("button", { name: "Install Git LFS for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(2));
  });

  it("announces the failure sentence alone, with the install's output as its own polite log", async () => {
    const pending: { release?: () => void } = {};
    const { user } = surface(lfsMissing, {
      installGate: new Promise<void>((resolve) => {
        pending.release = resolve;
      }),
    });
    const failure = await block();
    const alerts = within(failure).getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe("Git LFS is needed to check out this pull request.");
    expect(failure.getAttribute("role")).toBeNull();

    await user.click(within(failure).getByRole("button", { name: "Install Git LFS for me" }));
    const log = await waitFor(() => {
      const found = failure.querySelector<HTMLElement>('[data-slot="install-output"]');
      if (!found) throw new Error("no install output");
      return found;
    });
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.closest('[role="alert"]')).toBeNull();
    act(() => pending.release?.());
  });

  it("waits to install until it knows which machine the project is on", async () => {
    // The project lives in WSL. Until `settings.get` answers, "this Mac" is a guess — and a
    // wrong one would install Git LFS where the checkout does not run and report success.
    const settings = deferred();
    const { user, recorded } = surface(lfsMissing, { settingsGate: settings.promise });
    const failure = await block();
    const install = within(failure).getByRole("button", { name: "Install Git LFS for me" });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    await user.click(install);
    expect(recorded.installs).toEqual([]);

    settings.resolve();
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
    await user.click(install);
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    expect(recorded.installs[0]?.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
  });

  it("offers to check again when it could not learn which machine the project is on", async () => {
    const settings = deferred();
    settings.reject(new Error("settings unavailable"));
    const { recorded } = surface(lfsMissing, { settingsGate: settings.promise });
    const failure = await block();
    await waitFor(() =>
      expect(
        within(failure).getByText(/couldn't tell which machine this project is on/),
      ).toBeTruthy(),
    );
    expect(within(failure).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(
      (within(failure).getByRole("button", { name: "Install Git LFS for me" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(recorded.installs).toEqual([]);
  });

  it("says Skip large files is remembered for the project, as the large-file dialog does", async () => {
    const { user, recorded } = surface(lfsMissing);
    const failure = await block();
    expect(within(failure).getByText(LARGE_FILE_REMEMBERED)).toBeTruthy();
    await user.click(within(failure).getByRole("button", { name: "Skip large files" }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    // Exactly what the sentence says: remembered for the project.
    expect(recorded.choices[0]?.remember).toBe(true);
  });

  it("says plainly when Retry did not go through, and lets nothing escape", async () => {
    const { user, recorded } = surface(
      { status: "failed", stage: "workspace", reason: "x", kind: "unknown" },
      { retryFails: true },
    );
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
    expect(
      await within(failure).findByText("Rennet couldn't start this review again. Try again."),
    ).toBeTruthy();
  });

  it("still says a Retry did not go through after leaving the review and coming back", async () => {
    // The sentence is kept per session (`retryFailureKey`), not per mount: the route unmounts
    // the block, and the reviewer coming back must still see that their click went nowhere.
    const { user, recorded, history } = surface(
      { status: "failed", stage: "workspace", reason: "x", kind: "unknown" },
      { retryFails: true },
    );
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
    await within(failure).findByText("Rennet couldn't start this review again. Try again.");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="preparation-failure"]')).toBeNull(),
    );
    act(() => history.navigate("/s/sess-widget"));
    const back = await block();
    expect(back).not.toBe(failure);
    expect(
      await within(back).findByText("Rennet couldn't start this review again. Try again."),
    ).toBeTruthy();
    expect(recorded.retries).toHaveLength(1);
  });

  it("says plainly when Skip large files did not go through", async () => {
    const { user, recorded } = surface(lfsMissing, { writesFail: true });
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Skip large files" }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(
      await within(failure).findByText("Rennet couldn't record that choice. Try again."),
    ).toBeTruthy();
  });

  it("says plainly when Cancel did not go through", async () => {
    const { user } = surface(
      { status: "capturing", step: "capturing-change" },
      { writesFail: true },
    );
    const presence = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-kind="preparation-presence"]');
      if (!found) throw new Error("no presence");
      return found;
    });
    await user.click(await within(presence).findByRole("button", { name: "Cancel" }));
    expect(
      await within(presence).findByText("Rennet couldn't cancel this review. Try again."),
    ).toBeTruthy();
  });

  it("does NOT retry when the install failed, and says so plainly", async () => {
    const { user, recorded } = surface(lfsMissing, {
      install: {
        status: "failed",
        command: "brew install git-lfs && git lfs install",
        message: "Homebrew couldn't install Git LFS.",
        failedCommand: "brew install git-lfs",
        exitCode: 1,
        output: "Error: No available formula",
        probe: { id: "git-lfs", version: null, status: "not-installed", detail: "" },
      },
    });
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Install Git LFS for me" }));
    await waitFor(() =>
      expect(failure.textContent).toContain("Homebrew couldn't install Git LFS."),
    );
    expect(recorded.retries).toEqual([]);
  });

  it("skips large files as the other way forward when Git LFS is missing", async () => {
    const { user, recorded } = surface(lfsMissing);
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Skip large files" }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ sessionId: "sess-widget", mode: "skip" });
  });

  it("keeps the raw output behind Details until it is opened", async () => {
    const { user } = surface(lfsMissing);
    const failure = await block();
    // Not merely hidden: not on the page at all, so neither eyes nor a screen reader meet
    // git's stderr unless the reviewer asks for it.
    expect(document.body.textContent).not.toContain("command not found");
    expect(failure.querySelector('[data-slot="failure-detail-output"]')).toBeNull();

    await user.click(within(failure).getByText("Details"));

    await waitFor(() =>
      expect(failure.querySelector('[data-slot="failure-detail-output"]')?.textContent).toContain(
        "git-lfs: command not found",
      ),
    );
  });

  it("opens the large-file choice when that is the recovery", async () => {
    const { user, recorded } = surface({
      status: "failed",
      stage: "workspace",
      reason: "Git LFS couldn't download this pull request's large files.",
      kind: "large-file",
      action: "choose-large-files",
      detail: "Smudge error: Error downloading object",
      reviewId: REVIEW.id,
    });
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Choose large-file mode" }));
    const dialog = await screen.findByRole("dialog", { name: /large files/ });
    await user.click(within(dialog).getByRole("button", { name: /Skip large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "skip" });
  });

  it("routes Sign in to the account rows in Settings", async () => {
    const { user, history } = surface({
      status: "failed",
      stage: "workspace",
      reason: "GitHub didn't accept the saved credentials for this repository.",
      kind: "auth",
      action: "sign-in",
    });
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/settings/environments"));
  });

  it("leads an unclassified failure with a plain sentence, the raw reason behind Details", async () => {
    // Opus's screenshot: a seven-line wall of daemon text as the headline.
    const raw = "spawn git ENOENT\n    at ChildProcess._handle.onexit (node:internal)";
    const { user } = surface({
      status: "failed",
      stage: "capture",
      reason: raw,
      detail: "exit 128",
    });
    const failure = await block();
    expect(failure.querySelector("p")?.textContent).toBe("Rennet couldn't prepare this review.");
    expect(document.body.textContent).not.toContain("ENOENT");
    await user.click(within(failure).getByText("Details"));
    const detail = failure.querySelector('[data-slot="failure-detail-output"]')?.textContent;
    expect(detail).toContain("spawn git ENOENT");
    expect(detail).toContain("exit 128");
  });

  it("says no coding agent is installed when the unclassified failure says so", async () => {
    surface({
      status: "failed",
      stage: "boards",
      reason:
        "lens-draft-flagged resolved to no runnable review seat (no claude harness; no codex harness)",
    });
    const failure = await block();
    expect(failure.querySelector("p")?.textContent).toBe(
      "No coding agent is installed, so Rennet can't draft this review. Install Claude Code or Codex, then Retry.",
    );
    expect(document.body.textContent).not.toContain("runnable review seat");
    expect(within(failure).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps a classified failure's own plain sentence as its headline", async () => {
    surface({
      status: "failed",
      stage: "workspace",
      reason: "GitHub didn't accept the saved credentials for this repository.",
      kind: "auth",
      action: "sign-in",
      detail: "fatal: Authentication failed",
    });
    const failure = await block();
    expect(failure.querySelector("p")?.textContent).toBe(
      "GitHub didn't accept the saved credentials for this repository.",
    );
  });

  it("offers Retry alone for a failure it cannot classify", async () => {
    const { user, recorded } = surface({
      status: "failed",
      stage: "workspace",
      reason: "The pull request couldn't be checked out.",
      kind: "unknown",
      detail: "fatal: something unexpected",
    });
    const failure = await block();
    const buttons = within(failure)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons).toEqual(["Retry"]);
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
  });
});

describe("an install never acts for the reviewer when it lands", () => {
  const lfsMissing: SidebarSession["preparation"] = {
    status: "failed",
    stage: "workspace",
    reason: "Git LFS is needed to check out this pull request.",
    kind: "tool-missing",
    action: "install",
    tool: "git-lfs",
    reviewId: REVIEW.id,
  };
  const awaitingWithoutLfs: SidebarSession["preparation"] = {
    status: "awaiting",
    kind: "large-file-choice",
    lfsAvailable: false,
    reviewId: REVIEW.id,
  };
  const settleBeat = () => act(() => new Promise((resolve) => setTimeout(resolve, 80)));
  const presenceCancel = () =>
    waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="preparation-cancel"]');
      if (!found) throw new Error("no Cancel");
      return found;
    });

  /** Download, Install for me, then Escape: the install keeps running under the presence. */
  async function installThenEscape(user: ReturnType<typeof surface>["user"]) {
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Install for me" }));
    await user.keyboard("{Escape}");
    await screen.findByTestId("large-file-waiting");
  }

  it("dialog: Install, Escape, Cancel — the install landing answers nothing", async () => {
    const install = deferred();
    const live: { current: SidebarSession["preparation"] } = { current: awaitingWithoutLfs };
    const { user, recorded } = surface(awaitingWithoutLfs, {
      review: true,
      live,
      installGate: install.promise,
    });
    await installThenEscape(user);
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    await user.click(await presenceCancel());
    await waitFor(() => expect(recorded.cancels).toBe(1));
    await block();

    install.resolve();
    await settleBeat();
    // No Download sent: it would have resumed — captured and drafted — the cancelled review.
    // Nothing withdraws anything any more: an install simply never acts for the reviewer.
    expect(recorded.choices).toEqual([]);
    expect(recorded.retries).toEqual([]);
  });

  it("dialog: Install, Escape, the floating Cancel — the install landing answers nothing", async () => {
    // On the diff view the presence is not drawn, so Cancel is the floating chip — the
    // header's own control, not the presence's.
    const install = deferred();
    const live: { current: SidebarSession["preparation"] } = { current: awaitingWithoutLfs };
    const { user, recorded } = surface(awaitingWithoutLfs, {
      review: true,
      live,
      cancelSticks: false,
      installGate: install.promise,
      path: "/s/sess-widget?view=diff",
    });
    // The route paints the preparing frame first; the review workspace's dialog replaces it.
    await screen.findByRole("dialog", { name: /large files/ });
    await settleBeat();
    const dialog = await screen.findByRole("dialog", { name: /large files/ });
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await screen.findByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    await user.keyboard("{Escape}");
    await screen.findByTestId("large-file-waiting");
    expect(document.querySelector('[data-kind="preparation-presence"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel board generation" }));
    await waitFor(() => expect(recorded.cancels).toBe(1));

    install.resolve();
    await settleBeat();
    expect(recorded.choices).toEqual([]);
  });

  it("block: Install, Retry, Cancel — the install landing does not retry the cancelled review", async () => {
    const install = deferred();
    const live: { current: SidebarSession["preparation"] } = { current: lfsMissing };
    const { user, recorded } = surface(lfsMissing, {
      live,
      installGate: install.promise,
    });
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Install Git LFS for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
    await user.click(await presenceCancel());
    await waitFor(() => expect(recorded.cancels).toBe(1));

    install.resolve();
    await settleBeat();
    // Only the reviewer's own Retry: the landing install restarted nothing.
    expect(recorded.retries).toHaveLength(1);
  });
});

describe("the large-file choice while preparation waits on it", () => {
  const awaiting = (lfsAvailable: boolean): SidebarSession["preparation"] => ({
    status: "awaiting",
    kind: "large-file-choice",
    lfsAvailable,
    reviewId: REVIEW.id,
  });

  it("asks with two plain choices over the presence, and Download records the answer", async () => {
    const { user, recorded } = surface(awaiting(true), { review: true });
    const dialog = await choiceDialog();
    // Labelled by its title, so a screen reader announces what is being asked.
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      within(dialog).getByText("This repository stores large files with Git LFS"),
    ).toBeTruthy();
    expect(within(dialog).getByText("Full files in the checkout. Slower to open.")).toBeTruthy();
    expect(
      within(dialog).getByText("Faster. Large files appear as small placeholder files."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Rennet remembers this for the project. You can change it in Settings.",
      ),
    ).toBeTruthy();
    // The presence keeps animating behind the question: the review is still on its way.
    expect(document.querySelector('[data-kind="preparation-presence"]')).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ sessionId: "sess-widget", mode: "download" });
    // The project's answer: remembered (absent `remember` is the daemon's `true`).
    expect(recorded.choices[0]?.remember).not.toBe(false);
  });

  it("records Skip large files for the project", async () => {
    const { user, recorded } = surface(awaiting(true), { review: true });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Skip large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "skip" });
    expect(recorded.choices[0]?.remember).not.toBe(false);
  });

  it("offers Install for me and Skip for now when Download needs a missing Git LFS", async () => {
    const { user, recorded } = surface(awaiting(false), { review: true });
    const dialog = await choiceDialog();
    expect(within(dialog).getByText("Needs Git LFS, which isn't installed here.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    // Choosing Download did not record it yet: there is no Git LFS to download with.
    expect(recorded.choices).toEqual([]);
    await waitFor(() =>
      expect(within(dialog).getByText("Downloading large files needs Git LFS")).toBeTruthy(),
    );

    await user.click(within(dialog).getByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    expect(recorded.installs[0]?.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    // Installed ⇒ back to the choice, Download available and nothing sent for the reviewer.
    await waitFor(() =>
      expect(
        within(dialog).getByText("Git LFS is installed. You can download large files now."),
      ).toBeTruthy(),
    );
    expect(within(dialog).queryByText("Needs Git LFS, which isn't installed here.")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(recorded.choices).toEqual([]);
    // The reviewer's own click is what records Download.
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "download" });
    expect(recorded.installs).toHaveLength(1);
  });

  it("lands focus on Download when an install returns the dialog to its choices, and announces it in a region already there", async () => {
    // The install lands with no action from the reviewer: the "needs Git LFS" screen gives way
    // to the choices, and the control they were on (the running install's Cancel) unmounts. A
    // live region inserted with its text already inside is one many screen readers never
    // read, so the announcement goes into a region that was on the page, empty, beforehand.
    const install = deferred();
    const { user, recorded } = surface(awaiting(false), {
      review: true,
      installGate: install.promise,
    });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    within(dialog).getByRole("button", { name: "Cancel" }).focus();

    const region = dialog.querySelector<HTMLElement>('[data-slot="lfs-installed"]');
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");

    install.resolve();
    await waitFor(() =>
      expect(region?.textContent).toBe("Git LFS is installed. You can download large files now."),
    );
    // The SAME node, still on the page: its text changed, it was not inserted.
    expect(region?.isConnected).toBe(true);
    const download = within(dialog).getByRole("button", { name: /Download large files/ });
    await waitFor(() => expect(document.activeElement).toBe(download));
    // Focus is not an answer: nothing was recorded for the reviewer.
    expect(recorded.choices).toEqual([]);
  });

  it("skips for this review only when the reviewer picks Skip for now", async () => {
    const { user, recorded } = surface(awaiting(false), { review: true });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "skip", remember: false });
    expect(recorded.installs).toEqual([]);
  });

  it("closes on Escape to a calm line with a way back, never a dead end", async () => {
    const { user } = surface(awaiting(true), { review: true });
    await choiceDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /large files/ })).toBeNull());
    const waiting = await screen.findByTestId("large-file-waiting");
    expect(waiting.textContent).toContain("waiting for your choice about large files");
    // The presence is still going underneath, with Cancel still in reach.
    expect(document.querySelector('[data-kind="preparation-presence"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="preparation-cancel"]')).toBeTruthy();

    await user.click(within(waiting).getByRole("button", { name: "Choose large-file mode" }));
    expect(await choiceDialog()).toBeTruthy();
  });

  it("does not answer Download when an install lands after Skip for now was submitted", async () => {
    // Codex: a pending Skip followed by a successful install sent a SECOND choice —
    // Download, remembered — and persisted it over the reviewer's answer.
    const install = deferred();
    const choose = deferred();
    const { user, recorded } = surface(awaiting(false), {
      review: true,
      installGate: install.promise,
      chooseGate: choose.promise,
    });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));

    install.resolve();
    await waitFor(() => expect(dialog.textContent).toContain("Git LFS is installed"));
    choose.resolve();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(recorded.choices).toHaveLength(1);
    expect(recorded.choices[0]).toMatchObject({ mode: "skip", remember: false });
  });

  it("keeps the dialog's place and its running install when the review attaches mid-question", async () => {
    // The route swaps the preparing workspace for the review workspace the moment the review
    // attaches; everything under the header remounts. The reviewer's place in the dialog and
    // the install running under it must survive that.
    const attached = { current: false };
    const install = deferred();
    const { user, recorded } = surface(awaiting(false), {
      attached,
      installGate: install.promise,
    });
    let dialog = await screen.findByRole("dialog", { name: /large files/ });
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    expect(document.querySelector('[data-kind="lens-board-view"]')).toBeNull();

    attached.current = true;
    await waitFor(
      () => expect(document.querySelector('[data-kind="lens-board-view"]')).not.toBeNull(),
      { timeout: 3_000 },
    );
    dialog = await screen.findByRole("dialog", { name: /large files/ });
    // Still on the Install screen, still installing — not back at the two choices.
    expect(within(dialog).getByText("Downloading large files needs Git LFS")).toBeTruthy();
    expect(within(dialog).getByText(/Installing Git LFS/)).toBeTruthy();
    expect(recorded.installs).toHaveLength(1);

    install.resolve();
    // …and when it lands the remounted dialog offers Download, answering nothing itself.
    await waitFor(() => expect(within(dialog).getByText(/Git LFS is installed/)).toBeTruthy());
    expect(recorded.choices).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "download" });
  });

  it("still says a large-file answer did not go through after leaving the review and coming back", async () => {
    // Kept per session (`largeFileFailureKey`), so the remounted dialog says it.
    const { user, recorded, history } = surface(awaiting(true), {
      review: true,
      writesFail: true,
    });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Skip large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("connection lost");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /large files/ })).toBeNull());
    act(() => history.navigate("/s/sess-widget"));
    const reopened = await choiceDialog();
    expect(reopened).not.toBe(dialog);
    expect((await within(reopened).findByRole("alert")).textContent).toBe("connection lost");
    expect(recorded.choices).toHaveLength(1);
  });

  it("stays dismissed when the review attaches after Escape", async () => {
    const attached = { current: false };
    const { user } = surface(awaiting(true), { attached });
    await screen.findByRole("dialog", { name: /large files/ });
    await user.keyboard("{Escape}");
    await screen.findByTestId("large-file-waiting");

    attached.current = true;
    await waitFor(
      () => expect(document.querySelector('[data-kind="lens-board-view"]')).not.toBeNull(),
      { timeout: 3_000 },
    );
    expect(await screen.findByTestId("large-file-waiting")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /large files/ })).toBeNull();
  });

  it("finishes an install after Escape closed the dialog, and reopening it offers Download", async () => {
    const install = deferred();
    const { user, recorded } = surface(awaiting(false), {
      review: true,
      installGate: install.promise,
    });
    const dialog = await choiceDialog();
    await user.click(within(dialog).getByRole("button", { name: /Download large files/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Install for me" }));
    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    await user.keyboard("{Escape}");
    const waiting = await screen.findByTestId("large-file-waiting");

    install.resolve();
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(recorded.choices).toEqual([]);
    await user.click(within(waiting).getByRole("button", { name: "Choose large-file mode" }));
    const reopened = await choiceDialog();
    expect(within(reopened).getByText(/Git LFS is installed/)).toBeTruthy();
    await user.click(within(reopened).getByRole("button", { name: /Download large files/ }));
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "download" });
    expect(recorded.installs).toHaveLength(1);
  });

  it("holds first-run tips back while the review is still on its way", async () => {
    // After Escape, the "Five Lenses" card sat over the one control that reopens the
    // question. Nothing is there to teach yet, so no tip shows until the review is.
    const { user } = surface(awaiting(true), { review: true });
    await choiceDialog();
    await user.keyboard("{Escape}");
    await screen.findByTestId("large-file-waiting");
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole("button", { name: "Dismiss tip" })).toBeNull();
    expect(screen.queryByText("Five Lenses")).toBeNull();
  });

  it("returns focus to the way back after Escape", async () => {
    const { user } = surface(awaiting(true), { review: true });
    await choiceDialog();
    await user.keyboard("{Escape}");
    const waiting = await screen.findByTestId("large-file-waiting");
    const chooseAgain = within(waiting).getByRole("button", { name: "Choose large-file mode" });
    await waitFor(() => expect(document.activeElement).toBe(chooseAgain));
  });

  it("traps focus inside the dialog", async () => {
    const { user } = surface(awaiting(true), { review: true });
    const dialog = await choiceDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let step = 0; step < 6; step += 1) {
      await act(() => user.tab());
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe("workspace notes", () => {
  it("shows a skip-mode checkout's note quietly beside the review, not as a failure", async () => {
    const note = "Large files in this checkout are placeholders, because Git LFS isn't installed.";
    surface(undefined, { review: true, workspaceNotes: [note] });
    const notes = await waitFor(() => {
      const found = document.querySelector('[data-slot="workspace-notes"]');
      if (!found) throw new Error("no workspace notes");
      return found;
    });
    expect(notes.textContent).toBe(note);
    expect(notes.closest('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-testid="preparation-failure"]')).toBeNull();
  });
});
