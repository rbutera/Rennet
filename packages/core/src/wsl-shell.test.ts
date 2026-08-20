import { describe, expect, it } from "vitest";
import { lastAbsolutePathLine, shellLines, stripShellControl } from "./wsl-shell";

const PROMPT_ESC = "\x1b[5 q";

describe("stripShellControl", () => {
  it("removes ANSI escapes and control chars but PRESERVES newlines", () => {
    expect(stripShellControl(`${PROMPT_ESC}/home/rai\nwarning`)).toBe("/home/rai\nwarning");
    // A tab is control and goes; the newline stays so splitting still works.
    expect(stripShellControl("a\tb\nc")).toBe("ab\nc");
  });
});

describe("shellLines", () => {
  it("splits multi-line output into trimmed non-empty lines (newline not collapsed)", () => {
    expect(shellLines(`${PROMPT_ESC}/home/rai\n\n  warning  \n`)).toEqual(["/home/rai", "warning"]);
  });
});

describe("lastAbsolutePathLine", () => {
  it("returns the last line that is an absolute path, skipping noise", () => {
    expect(lastAbsolutePathLine("bash: warning\n/home/rai")).toBe("/home/rai");
    expect(lastAbsolutePathLine("/home/rai\nsome trailing note")).toBe("/home/rai");
  });

  it("returns null when no line is an absolute path", () => {
    expect(lastAbsolutePathLine("HOME: unbound variable")).toBe(null);
    expect(lastAbsolutePathLine("")).toBe(null);
  });
});
