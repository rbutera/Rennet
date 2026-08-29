import { describe, expect, it } from "vitest";
import { patchsetSchema } from "./index";

/**
 * #242 — the protocol schema silently stripped fields at the IPC boundary because
 * `z.ZodType<T>` catches a missing REQUIRED field but not a missing OPTIONAL one.
 * Protocol is now the source of truth: every wire type is `z.infer` of its schema,
 * so the type CANNOT declare a field the schema omits (the drift the old
 * `objectSchemaFor` weld guarded against is now impossible by construction). This
 * runtime guard proves a previously-stripped field still survives the round trip.
 */

describe("patchsetSchema — a previously-stripped field now survives the round trip (#242)", () => {
  it("preserves projectSnapshotId and intent (incl. nested specSnapshots) through parse", () => {
    // Before the weld, `patchsetSchema` omitted `projectSnapshotId` (#144) and
    // `intent` (#136); the `z.ZodType<Patchset>` annotation never noticed, and parse
    // stripped both — the type promised fields IPC never delivered. This reds if the
    // schema regresses to dropping them.
    const parsed = patchsetSchema.parse({
      id: "ps_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      repository: {
        id: "r",
        root: "/r",
        commonDir: "/r/.git",
        baseRef: "origin/main",
        baseOid: "0".repeat(40),
        headOid: "1".repeat(40),
        reviewedTreeOid: "2".repeat(40),
      },
      files: [],
      rawDiff: "",
      byteLength: 0,
      truncated: false,
      projectSnapshotId: "snap_abc",
      intent: {
        surface: "github-pr",
        prTitle: "Add X",
        prBody: "body",
        specSnapshots: [{ path: "spec.md", digest: "d1", content: "# Spec\nbody\n" }],
      },
    });

    expect(parsed.projectSnapshotId).toBe("snap_abc");
    expect(parsed.repository.reviewedTreeOid).toBe("2".repeat(40));
    expect(parsed.intent?.surface).toBe("github-pr");
    expect(parsed.intent?.prTitle).toBe("Add X");
    expect(parsed.intent?.specSnapshots?.[0]?.path).toBe("spec.md");
    // The nested OPTIONAL `content` must survive too — bypassing the nested
    // `PatchsetSpecSnapshot` weld and omitting it would drop a small snapshot's
    // captured text while every other assertion stayed green (the reviewer's find).
    expect(parsed.intent?.specSnapshots?.[0]?.content).toBe("# Spec\nbody\n");
  });
});
