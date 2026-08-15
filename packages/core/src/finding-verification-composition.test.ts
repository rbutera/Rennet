import type { FindingElement, PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { decompose } from "./decomposition";
import { runDualFindingReview } from "./dual-finding-review";
import type { DualSeat } from "./dual-seat";
import type { FindingProvenanceSeed } from "./finding-generation";
import {
  type VerificationFileReader,
  type VerificationTurn,
  verifyFlaggedReview,
} from "./finding-verification";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";

// ─────────────────────────────────────────────────────────────────────────────
// #207 — the LIVE deep-review composition: dual-model (#41) → verification (#179).
//
// The glue that #207 wires lives in the Electron main process (apps/desktop
// runFlaggedReview), which cannot be imported in isolation — its module top-level
// touches `app.setPath`/protocol registration. So this test pins the SAME
// composition semantics at the core seam, using the real `runDualFindingReview`
// and the real `verifyFlaggedReview`: a deep review's reconciled dual findings
// flow through the verification pass, and the maxVerifications cap is respected —
// the over-cap remainder surfaces an honest "not verified" caveat, NEVER a silent
// drop. Quick review (the byte-identical single-seat path) never verifies.
// ─────────────────────────────────────────────────────────────────────────────

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: null, deletions: null, binary: false, patch };
}
function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

// Three files → three offered hunks → three distinct anchors, so the dual review
// yields three separable findings (one per hunk) rather than one reconciled blob.
const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("src/a.ts", patch("src/a.ts", ["+const a = load();", "+use(a);"])),
    file("src/b.ts", patch("src/b.ts", ["+const b = fetch();", "+use(b);"])),
    file("src/c.ts", patch("src/c.ts", ["+const c = read();", "+use(c);"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
const HUNK_IDS = MANIFEST.occurrences.filter((o) => o.kind === "hunk").map((o) => o.id);

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};
const SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown",
  capability: CAPABILITY,
};

/** Three high-severity behavioural findings, one anchored to each offered hunk. */
const FINDINGS = [
  {
    anchor: `rennet:hunk/${HUNK_IDS[0]}`,
    summary: "value from load() may be null and is dereferenced",
    severity: "high",
  },
  {
    anchor: `rennet:hunk/${HUNK_IDS[1]}`,
    summary: "fetch() result is used before its promise resolves",
    severity: "high",
  },
  {
    anchor: `rennet:hunk/${HUNK_IDS[2]}`,
    summary: "read() can throw and the error is swallowed silently",
    severity: "high",
  },
];

function emits(findings: unknown[]): (p: string, a: number) => Promise<HarnessTurnResult> {
  return (_p, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body: { findings } }
        : { status: "failed", message: "no scripted body" },
    );
}

function seat(
  provider: "claude-code" | "codex",
  label: string,
  runTurn: (p: string, a: number) => Promise<HarnessTurnResult>,
): DualSeat {
  return { provider, label, seed: SEED, runTurn };
}

// A file reader that resolves any offered-hunk anchor to a distinct file window
// (one path per hunk id, so each verified finding is its own turn).
const readAny: VerificationFileReader = async (anchor) => {
  const id = anchor.split("/").pop() ?? "x";
  return { path: `${id}.ts`, startLine: 1, endLine: 2, text: "const v = read();\nuse(v);" };
};

// A verification turn that reproduces EVERY finding named in the prompt (each
// batch renders its members as `### f1 … / ### f2 …`).
const reproduceAll: VerificationTurn = async (prompt) => {
  const refs = [...prompt.matchAll(/### (f\d+)/g)].map((m) => m[1] as string);
  return {
    status: "emitted",
    body: {
      verifications: refs.map((ref) => ({
        ref,
        verdict: "reproduced",
        evidence: `reproduced at the offered window (${ref})`,
      })),
    },
  };
};

describe("#207 deep-review composition: dual findings → verification, cap respected", () => {
  it("composes verification over the reconciled dual findings and caps at maxVerifications", async () => {
    // Two seats emit the same three findings → three CONCUR findings after reconcile.
    const claude = seat("claude-code", "Claude", emits(FINDINGS));
    const codex = seat("codex", "Codex", emits(FINDINGS));

    const { review: flagged } = await runDualFindingReview({
      deepReview: true,
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      seats: [claude, codex],
      budget: createInvocationBudget(5),
    });
    expect(flagged.status).toBe("ok");
    if (flagged.status !== "ok") throw new Error("unreachable");
    expect(flagged.findings).toHaveLength(3);
    expect(flagged.dual).toBeDefined(); // it really is the dual-model path

    // The composition #207 wires: verify the dual findings, cap at 2.
    const cap = 2;
    const { review: verified, telemetry } = await verifyFlaggedReview(flagged, {
      manifest: MANIFEST,
      readFileWindow: readAny,
      runTurn: reproduceAll,
      budget: createInvocationBudget(10),
      maxVerifications: cap,
    });
    expect(verified.status).toBe("ok");
    if (verified.status !== "ok") throw new Error("unreachable");

    // Nothing is silently dropped: all three original findings still surface.
    expect(verified.findings).toHaveLength(3);

    // The cap is respected: exactly `cap` findings were verified (reproduced), and
    // the remainder carry an honest "not verified: cap reached" caveat — never a
    // silent skip that would read as an all-clear.
    const reproduced = verified.findings.filter(
      (f: FindingElement) => f.verification?.verdict === "reproduced",
    );
    const capped = verified.findings.filter(
      (f: FindingElement) =>
        f.verification?.verdict === "inconclusive" &&
        f.verification.evidence.includes(`verification cap of ${cap} was reached`),
    );
    expect(reproduced).toHaveLength(cap);
    expect(capped).toHaveLength(FINDINGS.length - cap);

    // Telemetry mirrors the visible per-finding chips (the surfacing is not silent).
    expect(telemetry.candidates).toBe(3);
    expect(telemetry.reproduced).toBe(cap);
    expect(telemetry.cappedFindingIds).toHaveLength(FINDINGS.length - cap);
  });

  it("QUICK review does not verify (single-seat, byte-identical to pre-#207)", async () => {
    // The quick path runs one seat and never composes verification: the caller
    // (runFlaggedReview) only verifies when `deepReview && adapter`. Modelled here
    // as the single-seat review carrying no verification chips.
    const claude = seat("claude-code", "Claude", emits([FINDINGS[0]]));
    const codex = seat("codex", "Codex", emits(FINDINGS));
    const { review: quick } = await runDualFindingReview({
      deepReview: false,
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      seats: [claude, codex],
      budget: createInvocationBudget(5),
    });
    expect(quick.status).toBe("ok");
    if (quick.status !== "ok") throw new Error("unreachable");
    expect(quick.dual).toBeUndefined();
    expect(quick.findings.every((f: FindingElement) => f.verification === undefined)).toBe(true);
  });
});
