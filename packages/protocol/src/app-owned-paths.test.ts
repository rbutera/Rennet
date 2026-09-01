import { describe, expect, it } from "vitest";
import { APP_OWNED_BOARD_SEGMENTS, isAppOwnedPath } from "./app-owned-paths";

describe("app-owned paths", () => {
  it("owns the board store root and everything beneath it", () => {
    expect(isAppOwnedPath(".rennet/boards")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/board-1.jsonl")).toBe(true);
    expect(isAppOwnedPath(".rennet/boards/gen/ps-1/board-1.jsonl")).toBe(true);
  });

  it("owns the same path under an absolute or nested prefix", () => {
    expect(isAppOwnedPath("/home/rai/dev/rennet/.rennet/boards/board-1.jsonl")).toBe(true);
    expect(isAppOwnedPath("packages/thing/.rennet/boards/board-1.jsonl")).toBe(true);
  });

  it("owns the backslash spelling Windows and WSL-UNC roots produce", () => {
    expect(isAppOwnedPath("C:\\dev\\rennet\\.rennet\\boards\\board-1.jsonl")).toBe(true);
    expect(isAppOwnedPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.rennet\\boards")).toBe(
      true,
    );
    // Mixed separators: chokidar on Windows hands back both flavours in one path.
    expect(isAppOwnedPath("C:\\dev\\repo/.rennet\\boards/board-1.jsonl")).toBe(true);
  });

  it("does not own a directory that merely starts with the same letters", () => {
    expect(isAppOwnedPath(".rennet/boards-extra")).toBe(false);
    expect(isAppOwnedPath(".rennet/boards-extra/notes.md")).toBe(false);
    expect(isAppOwnedPath(".rennet/boardsomething")).toBe(false);
    expect(isAppOwnedPath("src/.rennet-boards/x")).toBe(false);
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
    // The predicate and the writer's location are the same fact: joining the declared
    // segments must produce a path the predicate owns.
    expect(isAppOwnedPath(APP_OWNED_BOARD_SEGMENTS.join("/"))).toBe(true);
  });
});
