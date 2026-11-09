// @vitest-environment happy-dom

import type {
  CommandInput,
  CommandOutput,
  Review,
  SettingsView,
  SidebarSession,
} from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount, screen, waitFor, within } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

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

type InstallResult = CommandOutput<"tools.install">["result"];

interface Recorded {
  readonly installs: CommandInput<"tools.install">[];
  readonly choices: CommandInput<"session.chooseLargeFileMode">[];
  readonly retries: CommandInput<"session.retryPreparation">[];
}

function surface(
  preparation: SidebarSession["preparation"],
  options: { readonly review?: boolean; readonly install?: InstallResult } = {},
) {
  const recorded: Recorded = { installs: [], choices: [], retries: [] };
  const row = (): SidebarSession =>
    ({
      id: "sess-widget",
      projectId: "proj-widget",
      title: "feat/widget-lfs",
      target: "your-pr",
      createdAt: 0,
      claim: { branch: "feat/widget-lfs", prNumber: 7 },
      ...(options.review === true ? { reviewId: REVIEW.id } : {}),
      ...(preparation === undefined ? {} : { preparation }),
    }) as SidebarSession;
  const settings = {
    ...emptySettings(),
    projects: [{ projectId: "proj-widget", locus: { kind: "wsl", distro: "Ubuntu" } }],
  } as unknown as SettingsView;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": () => settings,
    "forge.hosts": () => ({ hosts: [] }),
    "session.list": () => ({ sessions: [row()] }),
    "session.cancelPreparation": () => ({ session: row() }),
    "session.retryPreparation": (input: CommandInput<"session.retryPreparation">) => {
      recorded.retries.push(input);
      return { session: row() };
    },
    "session.chooseLargeFileMode": (input: CommandInput<"session.chooseLargeFileMode">) => {
      recorded.choices.push(input);
      return { session: row() };
    },
    "tools.install": (input: CommandInput<"tools.install">) => {
      recorded.installs.push(input);
      return {
        result: options.install ?? {
          status: "installed",
          command: "brew install git-lfs && git lfs install",
          output: "Git LFS initialized.",
          probe: { id: "git-lfs", version: "3.6.1", status: "available", detail: "" },
        },
      };
    },
    "review.load": () => {
      if (options.review !== true) throw new Error("Review not found");
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
  const history = memoryHistory("/s/sess-widget");
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

  it("installs the missing tool where the project lives, then retries on its own", async () => {
    const { user, recorded } = surface(lfsMissing);
    const failure = await block();
    await user.click(within(failure).getByRole("button", { name: "Install Git LFS for me" }));

    await waitFor(() => expect(recorded.installs).toHaveLength(1));
    expect(recorded.installs[0]).toMatchObject({
      tool: "git-lfs",
      locus: { kind: "wsl", distro: "Ubuntu" },
    });
    // The re-probe said installed, so the block retried the preparation itself: the person
    // pressed one button to get unstuck, not two.
    await waitFor(() => expect(recorded.retries).toHaveLength(1));
    expect(failure.textContent).toContain("Git LFS is installed");
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
    // Installed ⇒ the Download the reviewer asked for goes through.
    await waitFor(() => expect(recorded.choices).toHaveLength(1));
    expect(recorded.choices[0]).toMatchObject({ mode: "download" });
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
