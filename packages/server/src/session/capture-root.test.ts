import type { Project } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { resolveCaptureRoot } from "./capture-root";

// A two-repo workspace whose rows BOTH sit on `main` — the shape without which the
// wrong-repo bug is invisible. `openPath` is repo A; a row can name repo B.
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "workspace",
    path: "/ws",
    kind: "workspace",
    repoCount: 2,
    branchCount: 2,
    primaryBranch: "main",
    openPath: "/ws/a",
    includedRepoPaths: ["/ws/a", "/ws/b"],
    addedAt: "2026-01-01T00:00:00.000Z",
    source: "local",
    ...overrides,
  };
}

describe("resolveCaptureRoot", () => {
  it("a row that names no repository (Current Checkout) takes the default root", () => {
    expect(resolveCaptureRoot(project(), undefined, undefined)).toEqual({ root: "/ws/a" });
  });

  it("a resolved identity takes ITS root, never the default", () => {
    // The row named repo B and it resolved — B's root, even though openPath is A.
    expect(resolveCaptureRoot(project(), "acme/b", "/ws/b")).toEqual({ root: "/ws/b" });
  });

  it("an unresolved identity in a MULTI-repo project refuses instead of grabbing openPath", () => {
    // The trap: B's identity is stale/unresolvable. The old `?? projectRoot`
    // fallback captured A's tree under B's row. We refuse loud instead.
    const decision = resolveCaptureRoot(project(), "acme/b", undefined);
    expect("error" in decision).toBe(true);
    // And crucially it does NOT hand back repo A's root.
    expect(decision).not.toEqual({ root: "/ws/a" });
  });

  it("an unresolved identity in a SINGLE-repo project still falls back (legacy rows stay clickable)", () => {
    const single = project({ repoCount: 1, includedRepoPaths: ["/ws/a"], openPath: "/ws/a" });
    expect(resolveCaptureRoot(single, "acme/a", undefined)).toEqual({ root: "/ws/a" });
  });

  it("a single-repo project stored before includedRepoPaths existed falls back on the default", () => {
    const legacy = project({ repoCount: 1, includedRepoPaths: undefined, openPath: "/ws/a" });
    expect(resolveCaptureRoot(legacy, "acme/a", undefined)).toEqual({ root: "/ws/a" });
  });
});
