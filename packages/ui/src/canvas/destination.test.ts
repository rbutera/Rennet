import { describe, expect, it } from "vitest";
import { addToBatch, batchPayload, type DispositionBatch, withdrawDraft } from "./authoring";
import {
  canSign,
  destinationVariant,
  draftsFromWrites,
  resolveSign,
  stagedItems,
  stagedPayload,
} from "./destination";
import type { DispositionWrite } from "./logic";

const writes: DispositionWrite[] = [
  { path: "src/b.ts", type: "approve", body: "looks right" },
  { path: "src/a.ts", type: "request-change", body: "rename this" },
];

function stage(...ws: DispositionWrite[]): DispositionBatch {
  return addToBatch([], draftsFromWrites(ws));
}

describe("destination variants — same staged data, two framings", () => {
  it("frames own-branch as the handoff bundle and other-pr as the review to post", () => {
    const own = destinationVariant("own-branch");
    const other = destinationVariant("other-pr");
    expect(own.destination).toBe("handoff");
    expect(other.destination).toBe("publish");
    expect(own.title).not.toBe(other.title);
    expect(own.signLabel).not.toBe(other.signLabel);
    // Distinct framing, but they are variants of the SAME concept.
    expect(own.mode).toBe("own-branch");
    expect(other.mode).toBe("other-pr");
  });
});

describe("dispose == staged", () => {
  it("stages a disposition from the L2 writes a host already emits, in one act", () => {
    const batch = stage(...writes);
    const items = stagedItems(batch);
    expect(items.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // The staged payload IS the #17 batch payload (byte-identical by construction).
    expect(stagedPayload(batch)).toBe(batchPayload(batch));
  });
});

describe("withdraw == unstage (zero residue)", () => {
  it("removes a staged draft entirely, sentinel gone from the staged payload", () => {
    const sentinel = "ZZ-UNIQUE-UNSTAGE-SENTINEL-Q7";
    const batch = stage(
      { path: "src/a.ts", type: "comment", body: sentinel },
      { path: "src/b.ts", type: "approve", body: "fine" },
    );
    expect(stagedPayload(batch)).toContain(sentinel);
    const after = withdrawDraft(batch, "src/a.ts");
    expect(stagedPayload(after)).not.toContain(sentinel);
    expect(stagedItems(after).map((entry) => entry.path)).toEqual(["src/b.ts"]);
  });
});

describe("canSign — hold-to-confirm gate, never defaults to approve", () => {
  it("blocks below the bar and permits at/above it", () => {
    expect(canSign(0, 800)).toBe(false);
    expect(canSign(799, 800)).toBe(false);
    expect(canSign(800, 800)).toBe(true);
    expect(canSign(1200, 800)).toBe(true);
  });

  it("accessibility floor 0 permits an immediate sign, and a negative budget clamps to 0", () => {
    expect(canSign(0, 0)).toBe(true);
    expect(canSign(0, -50)).toBe(true);
  });
});

describe("resolveSign — the one publish gate the sheet routes through", () => {
  const payload = '[{"path":"src/a.ts","type":"comment","body":"has \\"quotes\\" & <tags>"}]';

  it("never auto-approves: a hold below the bar emits NOTHING (null)", () => {
    // If this returned the payload instead of null, a too-short (or non-floor
    // zero-elapsed) hold would publish. That must be impossible.
    expect(resolveSign(0, 800, payload)).toBe(null);
    expect(resolveSign(799, 800, payload)).toBe(null);
  });

  it("what you see is what leaves: a cleared hold emits the payload BYTE-for-byte, never a transform", () => {
    // The emit side of "preview bytes == published bytes": whatever it emits, it
    // emits exactly the previewed bytes. Any transform (trim/normalise/re-encode)
    // makes this red.
    expect(resolveSign(800, 800, payload)).toBe(payload);
    expect(resolveSign(1200, 800, payload)).toBe(payload);
  });

  it("accessibility floor 0 emits the payload on an explicit act; a negative budget clamps to 0", () => {
    expect(resolveSign(0, 0, payload)).toBe(payload);
    expect(resolveSign(0, -50, payload)).toBe(payload);
  });

  it("emits the SAME bytes the sheet previews (stagedPayload), not a re-serialisation", () => {
    const batch = stage(...writes);
    // Ties the emitted bytes to the exact preview source: publish emits what the
    // <pre> shows. A divergent serialisation on either side makes this red.
    expect(resolveSign(800, 800, stagedPayload(batch))).toBe(stagedPayload(batch));
  });
});
