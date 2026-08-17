import { type HarnessEvent, type Locus, locusCommand, toWindowsView, WSL_EXE } from "@rennet/core";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter";
import {
  type CodexTransportEffects,
  createCodexTurnTransport,
  defaultCodexTransportEffects,
} from "./codex-turn-transport";
import { discoverCodex, wslDiscoveryDeps } from "./harness-discovery";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real WSL-locus codex round-trip (#334, task 5 — live counterpart
// of orchestrator-codex-live.real.test.ts).
//
// On a real Windows host with a WSL distro, this proves the WHOLE locus-aware
// codex path end to end: distro codex discovery through the distro's own login
// shell, a turn whose scratch is minted INSIDE the distro (`/tmp/…`) and whose
// Windows-side IO reads it back through the UNC view (`\\wsl.localhost\…`), and a
// composed spawn that goes through `wsl.exe -e` with distro-native `-C`/`-o` paths.
// Spends subscription quota and needs a distro + a distro codex, so SKIPPED unless
// RENNET_LIVE_WSL_CODEX=1; never in the gate. macOS / no-WSL: skipped cleanly.
//
//   RENNET_LIVE_WSL_CODEX=1 pnpm exec vitest run packages/adapters/src/codex-wsl-live.real.test.ts
//
// canvasOps is NOT asserted here: this transport-level turn does not consume the
// canvasops MCP server (that is wired at the orchestrator-session layer, proven by
// orchestrator-codex-live.real.test.ts). This test asserts exactly what the
// locus/transport seam owns. WSL usage/token accounting is a documented unmeasured
// ceiling, so nothing is claimed about usage.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_WSL_CODEX === "1";
const DISTRO = process.env.RENNET_LIVE_WSL_DISTRO ?? "Ubuntu";

/** Mint a throwaway git repo INSIDE the distro; return its distro-native path. */
async function mintDistroRepo(locus: Locus): Promise<string> {
  const script = [
    "set -e",
    "d=$(mktemp -d)",
    'cd "$d"',
    "git init -q",
    "git config user.email rennet-test@example.com",
    "git config user.name rennet-test",
    "printf hi > f.txt",
    "git add f.txt",
    "git -c commit.gpgsign=false commit -qm init",
    'printf %s "$d"',
  ].join("\n");
  const cmd = locusCommand(locus, "bash", ["-lc", script]);
  const { stdout } = await execa(cmd.file, [...cmd.args], { stdin: "ignore" });
  return stdout.trim();
}

describe("codex WSL locus — real distro round-trip (gated)", () => {
  it.skipIf(!LIVE)(
    "discovers, runs, and cleans up a real codex turn inside the WSL distro",
    async () => {
      const locus: Locus = { kind: "wsl", distro: DISTRO };

      const discovery = await discoverCodex(await wslDiscoveryDeps(DISTRO));
      expect(
        discovery.chosen,
        `no codex discovered in distro ${DISTRO}: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!discovery.chosen) return;

      // Record the composed spawn argv so the locus/path composition is asserted
      // against the REAL app-server transport.
      const spawns: { bin: string; args: readonly string[] }[] = [];
      const base = defaultCodexTransportEffects;
      const effects: CodexTransportEffects = {
        spawn: (spawnSpec) => {
          spawns.push({ bin: spawnSpec.bin, args: spawnSpec.args });
          return base.spawn(spawnSpec);
        },
      };

      const repoDistro = await mintDistroRepo(locus);
      const repoUnc = toWindowsView(repoDistro, DISTRO);
      try {
        const adapter = new CodexAdapter({
          binaryPath: discovery.chosen.path,
          transport: createCodexTurnTransport(
            discovery.chosen.path,
            effects,
            locus,
            discovery.chosen.runtimePath,
          ),
          version: discovery.chosen.version,
        });

        const session = await adapter.createSession({ cwd: repoUnc });
        await session.send({ prompt: "Reply with the single word ok. Do not edit any files." });
        const events: HarnessEvent[] = [];
        for await (const event of session.events) events.push(event);

        // (1) The turn completed.
        const ended = events.find((e) => e.kind === "session.ended");
        const outcome = ended?.kind === "session.ended" ? ended.outcome : undefined;
        expect(outcome?.status, `outcome: ${JSON.stringify(outcome)}`).toBe("completed");
        if (outcome?.status === "completed") {
          expect(outcome.finalText.toLowerCase()).toContain("ok");
        }

        // (2) The spawn went through `wsl.exe -e` with the distro cwd on `--cd`,
        // launching `codex app-server`. When the distro codex is an asdf JS
        // launcher, its sibling node rides INSIDE the `-e` argv ahead of the codex
        // path (`… -e <node> <codex> app-server`).
        const argv = spawns[0];
        expect(argv?.bin).toBe(WSL_EXE);
        const a = argv?.args ?? [];
        expect(a.slice(0, 4)).toEqual(["-d", DISTRO, "--cd", repoDistro]);
        expect(a[4]).toBe("-e");
        const runtime = discovery.chosen.runtimePath;
        if (runtime === undefined) {
          expect(a[5]).toBe(discovery.chosen.path);
          expect(a[6]).toBe("app-server");
        } else {
          expect(a[5]).toBe(runtime); // the paired distro node
          expect(a[6]).toBe(discovery.chosen.path); // the codex JS launcher
          expect(a[7]).toBe("app-server");
        }
        // stdio is locus-transparent: the whole JSON-RPC turn crosses the wsl
        // boundary unchanged, so there are NO `-C`/`-o` argv paths and no scratch.
        expect(a).not.toContain("-C");
        expect(a).not.toContain("-o");
      } finally {
        // Tolerant cleanup of the distro fixture — a leak must not fail the test.
        const rm = locusCommand(locus, "rm", ["-rf", repoDistro]);
        await execa(rm.file, [...rm.args], { stdin: "ignore", reject: false }).catch(
          () => undefined,
        );
      }
    },
    180_000,
  );
});
