import { describe, expect, it } from "vitest";
import {
  APP_OWNED_BOARD_SEGMENTS,
  isAppOwnedPath,
  toRepositoryRelativePath,
} from "./app-owned-paths";

describe("app-owned paths", () => {
  it("owns the board store root and everything beneath it", () => {
    expect(isAppOwnedPath(".rennet/boards")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/board-1.jsonl")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/gen/ps-1/board-1.jsonl")).toBe(true);
  });

  it("owns the backslash spelling Windows and WSL-UNC roots produce", () => {
    expect(isAppOwnedPath(".rennet\\boards\\board-1.jsonl")).toBe(true);
    expect(isAppOwnedPath(".rennet\\boards")).toBe(true);
    // Mixed separators: chokidar on Windows hands back both flavours in one path.
    expect(isAppOwnedPath(".rennet\\boards/gen/board-1.jsonl")).toBe(true);
  });

  it("does not own a nested `.rennet/boards` — the app only ever writes at the root", () => {
    // The store is exactly `<repositoryRoot>/.rennet/boards/` (`boards-runtime.ts` joins
    // the segments below onto the project root). A `.rennet/boards` a user keeps inside a
    // subdirectory is their content and must capture, and must mark the repo dirty.
    expect(isAppOwnedPath("packages/thing/.rennet/boards/board-1.jsonl")).toBe(false);
    expect(isAppOwnedPath("packages/thing/.rennet/boards")).toBe(false);
    expect(isAppOwnedPath("vendor\\pkg\\.rennet\\boards\\board-1.jsonl")).toBe(false);
  });

  it("does not own an absolute path — ownership is root-relative", () => {
    // Absolute paths are the caller's to relativize; claiming them is how a checkout
    // sitting under an ancestor `.rennet/boards` swallowed its whole tree.
    expect(isAppOwnedPath("/home/rai/dev/rennet/.rennet/boards/board-1.jsonl")).toBe(false);
    expect(isAppOwnedPath("C:\\dev\\rennet\\.rennet\\boards\\board-1.jsonl")).toBe(false);
  });

  it("does not claim a checkout that itself sits under a `.rennet/boards` ancestor", () => {
    // Regression: an unanchored predicate matched `.rennet/boards` anywhere, so EVERY
    // absolute path in this checkout was "app-owned" — capture would have emptied the
    // patchset and the watcher would have gone permanently silent.
    //
    // Control: this reddens only when BOTH halves of the fix are removed (unanchor the
    // predicate AND stop relativizing), which is precisely the pre-fix watcher handing
    // chokidar's absolute path to an unanchored regex. Anchoring alone already refuses
    // an absolute path — that is what the test above pins — so this one is a claim about
    // the composition, not about the regex.
    const root = "/home/rai/.rennet/boards/checkout";
    for (const absolute of [`${root}/src/app.ts`, `${root}/.rennet/conventions.json`]) {
      const relative = toRepositoryRelativePath(root, absolute);
      expect(relative).toBeDefined();
      expect(isAppOwnedPath(relative as string)).toBe(false);
    }
    // …while this checkout's own store is still owned.
    expect(
      isAppOwnedPath(toRepositoryRelativePath(root, `${root}/.rennet/boards/b.jsonl`) ?? ""),
    ).toBe(true);
  });

  it("does not own a directory that merely starts with the same letters", () => {
    expect(isAppOwnedPath(".rennet/boards-extra")).toBe(false);
    expect(isAppOwnedPath(".rennet/boards-extra/notes.md")).toBe(false);
    expect(isAppOwnedPath(".rennet/boardsomething")).toBe(false);
    expect(isAppOwnedPath(".rennet-boards/x")).toBe(false);
  });

  it("does not own the user's own tracked content elsewhere under .rennet", () => {
    // Tracked means intentional (#729 acceptance): excluding all of `.rennet` is forbidden.
    expect(isAppOwnedPath(".rennet/conventions.json")).toBe(false);
    expect(isAppOwnedPath(".rennet/knowledge/decisions.md")).toBe(false);
    expect(isAppOwnedPath(".rennet/.gitignore")).toBe(false);
    expect(isAppOwnedPath(".rennet")).toBe(false);
  });

  it("does not own a `boards` directory outside `.rennet`", () => {
    expect(isAppOwnedPath("boards/board-1.jsonl")).toBe(false);
    expect(isAppOwnedPath("docs/boards/index.md")).toBe(false);
  });

  it("declares the store segments the writer joins", () => {
    expect(APP_OWNED_BOARD_SEGMENTS).toEqual([".rennet", "boards"]);
    // The predicate and the writer's location are the same fact: the writer joins these
    // segments onto the project root, so the same join relative to that root must be owned.
    const root = "/home/rai/dev/repo";
    const store = `${root}/${APP_OWNED_BOARD_SEGMENTS.join("/")}`;
    expect(isAppOwnedPath(toRepositoryRelativePath(root, store) ?? "")).toBe(true);
    expect(isAppOwnedPath(APP_OWNED_BOARD_SEGMENTS.join("/"))).toBe(true);
  });
});

describe("toRepositoryRelativePath", () => {
  it("relativizes a path beneath the root, in either separator flavour", () => {
    expect(toRepositoryRelativePath("/repo", "/repo/src/app.ts")).toBe("src/app.ts");
    expect(toRepositoryRelativePath("C:\\dev\\repo", "C:\\dev\\repo\\src\\app.ts")).toBe(
      "src\\app.ts",
    );
    expect(
      toRepositoryRelativePath(
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.rennet\\boards\\b.jsonl",
      ),
    ).toBe(".rennet\\boards\\b.jsonl");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(toRepositoryRelativePath("/repo/", "/repo/src/app.ts")).toBe("src/app.ts");
    expect(toRepositoryRelativePath("C:\\dev\\repo\\", "C:\\dev\\repo\\src\\app.ts")).toBe(
      "src\\app.ts",
    );
  });

  it("yields the empty string for the root itself", () => {
    expect(toRepositoryRelativePath("/repo", "/repo")).toBe("");
    expect(toRepositoryRelativePath("/repo/", "/repo")).toBe("");
    expect(isAppOwnedPath("")).toBe(false);
  });

  it("refuses a path that is not beneath the root", () => {
    // A sibling whose name merely starts with the root's is NOT inside it.
    expect(toRepositoryRelativePath("/repo", "/repo-2/src/app.ts")).toBeUndefined();
    expect(toRepositoryRelativePath("/repo", "/other/src/app.ts")).toBeUndefined();
  });
});
