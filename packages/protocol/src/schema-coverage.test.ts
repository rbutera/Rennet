import type { FindingElement } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  findingAgreementSchema,
  findingSeveritySchema,
  objectSchemaFor,
  patchsetSchema,
} from "./index";

/**
 * #242 — the protocol schema silently stripped fields at the IPC boundary because
 * `z.ZodType<T>` catches a missing REQUIRED field but not a missing OPTIONAL one.
 * `objectSchemaFor<T>` welds each object schema to its type so a forgotten field
 * (optional included) is a BUILD ERROR. Two guards below: a compile-time one that
 * the weld actually bites, and a runtime one that a previously-stripped field now
 * survives the round trip.
 */

describe("objectSchemaFor — the #242 coverage weld is a COMPILE guard", () => {
  it("omitting an optional field the type declares does not compile", () => {
    // `FindingElement.verification?` is OPTIONAL. The old `z.ZodType<FindingElement>`
    // annotation accepted a schema that omitted it (still assignable), so it stripped
    // silently (#179). With the weld, omitting it is a type error — so the
    // `@ts-expect-error` below is SATISFIED. If the weld ever regresses, there is no
    // error to expect and this directive becomes an unused-directive error that reds
    // the `typecheck` target (which includes *.test.ts). All other fields are correct
    // so the ONLY possible error is the missing `verification`.
    // @ts-expect-error - `verification` (optional on FindingElement) is omitted; the weld must reject it
    const incomplete = objectSchemaFor<FindingElement>()({
      findingId: z.string(),
      anchor: z.string(),
      summary: z.string(),
      severity: findingSeveritySchema,
      agreement: findingAgreementSchema,
    });
    // The value still constructs at runtime (the guard is purely at the type level).
    expect(incomplete).toBeDefined();
  });
});

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
        specSnapshots: [{ path: "spec.md", digest: "d1" }],
      },
    });

    expect(parsed.projectSnapshotId).toBe("snap_abc");
    expect(parsed.intent?.surface).toBe("github-pr");
    expect(parsed.intent?.prTitle).toBe("Add X");
    expect(parsed.intent?.specSnapshots?.[0]?.path).toBe("spec.md");
  });
});
