import type { DiscoveryResult } from "@rennet/adapters";
import { describe, expect, it } from "vitest";
import { resolveProviderBinaries } from "./resolve-provider-binaries";

// ─────────────────────────────────────────────────────────────────────────────
// #890 — a discovery probe that fails must degrade the harness AND be logged.
//
// The defect was not that discovery could fail; it is meant to. It was that BOTH failure
// modes were discarded on the way out. The assertions are therefore on the warning sink and
// on the returned paths — the two things a person debugging "why is there no Codex seat"
// can actually reach — not on a spy over the discovery functions.
//
// WHAT THIS CANNOT CATCH: it does not prove `create-server` passes the real
// `discoverClaude`/`discoverCodex` in, and it does not prove `console.warn` reaches
// `~/.rennet/daemon.log`. It pins the reporting contract of this function only.
// ─────────────────────────────────────────────────────────────────────────────

const ready = (path: string): DiscoveryResult => ({
  candidates: [],
  chosen: { path, version: "1.2.3" },
  health: { state: "ready", version: "1.2.3" },
});

/** Discovery answered, and the answer was "no" — with a reason it knows and we dropped. */
const handshakeFailed = async (): Promise<DiscoveryResult> => ({
  candidates: [],
  chosen: null,
  health: {
    state: "unavailable",
    reason: "handshake-failed",
    detail:
      "codex 0.147.0 at /Users/x/.asdf/bin/codex did not answer the app-server initialize handshake.",
  },
});

describe("resolveProviderBinaries names the harness it could not resolve (#890)", () => {
  it("carries the health detail of a probe that answered no, instead of dropping it", async () => {
    const warnings: string[] = [];
    const binaries = await resolveProviderBinaries({
      claude: async () => ready("/usr/local/bin/claude"),
      codex: handshakeFailed,
      warn: (message) => warnings.push(message),
    });

    // The harness degrades — that half always worked.
    expect(binaries).toEqual({ claude: "/usr/local/bin/claude" });
    // And now it says so. This is the half that was missing entirely.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("codex");
    expect(warnings[0]).toContain("handshake-failed");
    // The daemon's own sentence, verbatim — the path it tried is the whole point of logging.
    expect(warnings[0]).toContain("did not answer the app-server initialize handshake");
  });

  it("carries a THROWN discovery failure, which `.catch(() => null)` swallowed whole", async () => {
    const warnings: string[] = [];
    const binaries = await resolveProviderBinaries({
      claude: async () => ready("/usr/local/bin/claude"),
      codex: async () => {
        throw new Error("EMFILE: too many open files, spawn");
      },
      warn: (message) => warnings.push(message),
    });

    expect(binaries).toEqual({ claude: "/usr/local/bin/claude" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EMFILE: too many open files, spawn");
  });

  it("does not fail the daemon when BOTH probes throw — it reports and returns nothing", async () => {
    // Containment, stated as a test: the sidecar comes up degraded, the daemon lives. This
    // is the property the crash in #890's log violated by other means.
    const warnings: string[] = [];
    const binaries = await resolveProviderBinaries({
      claude: async () => {
        throw new Error("claude probe blew up");
      },
      codex: async () => {
        throw new Error("codex probe blew up");
      },
      warn: (message) => warnings.push(message),
    });

    expect(binaries).toEqual({});
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("claude probe blew up");
    expect(warnings.join("\n")).toContain("codex probe blew up");
  });

  it("says nothing when both resolve, so the warnings above are not unconditional", async () => {
    const warnings: string[] = [];
    const binaries = await resolveProviderBinaries({
      claude: async () => ready("/usr/local/bin/claude"),
      codex: async () => ready("/usr/local/bin/codex"),
      warn: (message) => warnings.push(message),
    });

    expect(binaries).toEqual({
      claude: "/usr/local/bin/claude",
      codex: "/usr/local/bin/codex",
    });
    expect(warnings).toEqual([]);
  });

  it("one harness failing never costs the other its path", async () => {
    const warnings: string[] = [];
    const binaries = await resolveProviderBinaries({
      claude: handshakeFailed,
      codex: async () => ready("/usr/local/bin/codex"),
      warn: (message) => warnings.push(message),
    });
    expect(binaries).toEqual({ codex: "/usr/local/bin/codex" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("claude");
  });
});
