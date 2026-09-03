import type {
  CouncilResolveContext,
  FindingElement,
  OfferedManifest,
  RspCapabilitySnapshot,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { CodexUtilityPort } from "./codex-utility-port";
import type { FindingProvenanceSeed } from "./dual-seat";
import {
  DEFAULT_CODEX_SECOND_SEAT_EFFORT,
  DEFAULT_CODEX_SECOND_SEAT_MODEL,
  DEFAULT_SEAT_LABELS,
  resolveDualSeat,
} from "./dual-seat";
import { reconcileFindings } from "./finding-reconcile";
import type { HarnessTurnResult } from "./harness-run-turn";
import { providerHarness, resolveAssignment } from "./model-council";

const NO_CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
  perCallModelSelection: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
};

const BASE_SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown",
  capability: NO_CAPABILITY,
};

const MANIFEST: OfferedManifest = { occurrences: [{ id: "h1", kind: "hunk" }] };

// A claude turn that never actually runs in these resolution tests.
const claudeTurn = async (): Promise<HarnessTurnResult> => ({
  status: "failed",
  message: "not invoked",
});

// A stub port; resolveDualSeat wraps it in createCodexRunTurn but never calls it.
const codexPort = {} as CodexUtilityPort;

function baseInput() {
  return {
    jobId: "finding-generation",
    docType: "finding" as const,
    patchsetId: "patch-1",
    manifest: MANIFEST,
    baseSeed: BASE_SEED,
    claudeTurn,
    codexPort,
  };
}

describe("resolveDualSeat — the dual-model seat resolver (#41)", () => {
  it("returns an ORDERED pair (Claude, Codex) when both providers are installed", () => {
    const council: CouncilResolveContext = {
      availability: { installed: ["claude-code", "codex"] },
    };
    const seats = resolveDualSeat({ ...baseInput(), council });
    expect(seats.map((s) => s.provider)).toEqual(["claude-code", "codex"]);
    expect(seats.map((s) => s.label)).toEqual(["Claude", "Codex"]);
    expect(seats[0]?.seed.harness).toBe("claude-code");
    expect(seats[1]?.seed.harness).toBe("codex");
    // Every seat has an executor.
    expect(typeof seats[0]?.runTurn).toBe("function");
    expect(typeof seats[1]?.runTurn).toBe("function");
  });

  it("stamps the council-assigned provider's resolved model + trace; the other seat carries none", () => {
    const council: CouncilResolveContext = {
      availability: { installed: ["claude-code", "codex"] },
    };
    const resolution = resolveAssignment("finding-generation", council);
    if (resolution.kind !== "model") throw new Error("expected a model resolution");
    const assignedProvider = providerHarness(resolution.model);

    const seats = resolveDualSeat({ ...baseInput(), council });
    const assigned = seats.find((s) => s.provider === assignedProvider);
    const other = seats.find((s) => s.provider !== assignedProvider);

    expect(assigned?.seed.model).toBe(resolution.model);
    expect(assigned?.seed.resolutionTrace).toEqual(resolution.trace);
    expect(other?.seed.resolutionTrace).toBeUndefined();
  });

  it("returns ONE Claude seat under claude-only (single provider, no dual)", () => {
    const council: CouncilResolveContext = { availability: { installed: ["claude-code"] } };
    const seats = resolveDualSeat({ ...baseInput(), council, codexPort: undefined });
    expect(seats).toHaveLength(1);
    expect(seats[0]?.provider).toBe("claude-code");
  });

  it("returns ONE Codex seat under codex-only, defaulting the model when the council did not pick it", () => {
    const council: CouncilResolveContext = { availability: { installed: ["codex"] } };
    const seats = resolveDualSeat({ ...baseInput(), council, claudeTurn: undefined });
    expect(seats).toHaveLength(1);
    expect(seats[0]?.provider).toBe("codex");
    expect(seats[0]?.seed.harness).toBe("codex");
    // A codex-only finding job may resolve to a codex model; if not, the default stands.
    expect(typeof seats[0]?.seed.model).toBe("string");
    expect(seats[0]?.seed.model.length).toBeGreaterThan(0);
  });

  it("falls back to the Claude seat only when there is no council (mirrors resolveSeat)", () => {
    const seats = resolveDualSeat({ ...baseInput() });
    expect(seats).toHaveLength(1);
    expect(seats[0]?.provider).toBe("claude-code");
  });

  it("omits a provider that is installed but has NO executor", () => {
    const council: CouncilResolveContext = {
      availability: { installed: ["claude-code", "codex"] },
    };
    // codex installed but no port ⇒ only the Claude seat is runnable.
    const seats = resolveDualSeat({ ...baseInput(), council, codexPort: undefined });
    expect(seats.map((s) => s.provider)).toEqual(["claude-code"]);
  });

  it("honours label overrides", () => {
    const council: CouncilResolveContext = {
      availability: { installed: ["claude-code", "codex"] },
    };
    const seats = resolveDualSeat({
      ...baseInput(),
      council,
      labels: { "claude-code": "Opus", codex: "Sol" },
    });
    expect(seats.map((s) => s.label)).toEqual(["Opus", "Sol"]);
    expect(DEFAULT_SEAT_LABELS["claude-code"]).toBe("Claude");
    expect(DEFAULT_SEAT_LABELS.codex).toBe("Codex");
    expect(seats[1]?.seed.model).toBe(
      // when the council doesn't pick codex, the codex seat defaults its model
      seats[1]?.seed.resolutionTrace ? seats[1]?.seed.model : DEFAULT_CODEX_SECOND_SEAT_MODEL,
    );
  });

  // Rai's ruling: the second opinion is the STRONGEST Codex model at high effort,
  // never the cheap light-tier utility default. Under `both` the council assigns
  // finding-generation to Claude, so the Codex seat is exactly that second seat.
  it("fills the unassigned Codex second seat with gpt-5.6-sol at high effort", () => {
    const council: CouncilResolveContext = {
      availability: { installed: ["claude-code", "codex"] },
    };
    const seats = resolveDualSeat({ ...baseInput(), council });
    const codex = seats.find((s) => s.provider === "codex");
    expect(codex?.seed.resolutionTrace).toBeUndefined(); // the council did not pick it
    expect(codex?.seed.model).toBe("gpt-5.6-sol");
    expect(codex?.seed.effort).toBe("high");
    expect(DEFAULT_CODEX_SECOND_SEAT_MODEL).toBe("gpt-5.6-sol");
    expect(DEFAULT_CODEX_SECOND_SEAT_EFFORT).toBe("high");
  });

  // B08 J1/J2: `lens-draft-flagged` is the board-era Flagged seat — the same dual
  // shape as finding-generation. Under `both` the council picks Claude (opus-4.8),
  // so Codex fills the second seat at the strongest-model default; under a single
  // provider it degrades to one honest seat. The merge is `reconcileFindings`
  // (proven in finding-reconcile.test.ts).
  describe("lens-draft-flagged — the Flagged dual seat (#489 B08)", () => {
    const flagged = () => ({ ...baseInput(), jobId: "lens-draft-flagged" as const });

    it("runs as an ordered Claude+Codex pair under both", () => {
      const council: CouncilResolveContext = {
        availability: { installed: ["claude-code", "codex"] },
      };
      const seats = resolveDualSeat({ ...flagged(), council });
      expect(seats.map((s) => s.provider)).toEqual(["claude-code", "codex"]);
      // Claude is the council-assigned primary; Codex is the second opinion.
      const claude = seats.find((s) => s.provider === "claude-code");
      const codex = seats.find((s) => s.provider === "codex");
      expect(claude?.seed.model).toBe("opus-4.8");
      expect(claude?.seed.resolutionTrace).toBeDefined();
      expect(codex?.seed.model).toBe(DEFAULT_CODEX_SECOND_SEAT_MODEL);
    });

    it("degrades to a single honest seat when only one provider is installed", () => {
      const claudeOnly = resolveDualSeat({
        ...flagged(),
        council: { availability: { installed: ["claude-code"] } },
        codexPort: undefined,
      });
      expect(claudeOnly.map((s) => s.provider)).toEqual(["claude-code"]);
      const codexOnly = resolveDualSeat({
        ...flagged(),
        council: { availability: { installed: ["codex"] } },
        claudeTurn: undefined,
      });
      expect(codexOnly.map((s) => s.provider)).toEqual(["codex"]);
    });

    it("merges through finding-reconcile: two seats at one location fold to a concur row (J2)", () => {
      // The production Flagged merge point. Two seats independently raise the same
      // location; reconcile must fold them into ONE concur row (2 of 2) carrying
      // one seat's verbatim summary — never a synthesised third summary.
      const claudeSeat: FindingElement[] = [
        {
          findingId: "cl-1",
          anchor: "rennet:hunk/h1#L10@additions",
          summary: "a declined refresh is misclassified as a network failure",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
        },
      ];
      const codexSeat: FindingElement[] = [
        {
          findingId: "cx-1",
          anchor: "rennet:hunk/h1#L11@additions", // gap 1 ≤ proximity 3 → same location
          summary: "the refresh error path returns the wrong classification",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
        },
      ];
      const merged = reconcileFindings(claudeSeat, codexSeat, { a: "Claude", b: "Codex" });
      expect(merged).toHaveLength(1);
      expect(merged[0]?.agreement).toEqual({ kind: "concur", agree: 2, total: 2 });
      expect(merged[0]?.severity).toBe("high");
      // Verbatim selection: the surviving summary is one of the two seats', not a merge.
      expect([claudeSeat[0]?.summary, codexSeat[0]?.summary]).toContain(merged[0]?.summary);
    });

    it("merges through finding-reconcile: a solo finding surfaces as a labelled disagreement (J2)", () => {
      const claudeSeat: FindingElement[] = [
        {
          findingId: "cl-1",
          anchor: "rennet:hunk/h9#L4@additions",
          summary: "only Claude flags the missing guard",
          severity: "medium",
          agreement: { kind: "concur", agree: 1, total: 1 },
        },
      ];
      const merged = reconcileFindings(claudeSeat, [], { a: "Claude", b: "Codex" });
      expect(merged).toHaveLength(1);
      expect(merged[0]?.agreement.kind).toBe("disagree");
    });
  });
});
