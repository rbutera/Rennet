# Design — wsl-remainder

## Context

See proposal.md. The locus machinery is complete and battle-tested: `packages/core/src/locus.ts` owns `detectLocus`, `toDistroPath`/`toWindowsView`, and `locusCommand` (wsl.exe `-d <distro> [--cd <cwd>] -e <argv…>`, byte-verbatim, no shell). Desktop MAIN resolves per-repo locus via `locusForRepo` (settings resolver, `detected` rung) and already threads it through git, checkpoint, submit-push, the handoff write turn, and `getClaudeHarness(locus, distroCwd)`. The remainder is two mechanical seams plus one genuinely new problem (distro-reachable canvasOps) plus live verification.

Verified host-defaulting sites (apps/desktop/src/main/index.ts): 664 (canvas lenses), 1135 (flagged), 1435 (spec-delta), 1517 (noise), 1718 (proactive knowledge), 1854 (orchestrator `resolveKnowledgePort` — wired once, no review in scope), 2044 (symbol lookup), 2108 (refine), 2144 (draft PR body), 2174 (delta digest), plus the compose-bundle port. Codex sites: `codex-turn-transport.ts` `realSpawn`:58 + scratch mkdtemp:134; `codex-exec.ts` `createCodexExecutor`:256 + scratch:285; argv built in `codex-adapter.ts` `buildCodexTurnArgs`:60 (`-C`, `-o`, `--output-schema`, `-c mcp_servers.*.url`); URL minted in `canvas-ops-external.ts`:138 (`http://127.0.0.1:<port>/mcp`).

## Goals / Non-Goals

**Goals:**

- Dual-harness WSL reviews: distro codex runs real turns with working scratch, argv, and canvasOps.
- Full-context WSL reviews: every read-pipeline model turn resolves the project's locus.
- Live win32 proof on lancelot for the deferred verification matrix.

**Non-Goals:**

- No ARM64-Windows, WSL1, or non-WSL2 scope (already cut in add-windows-support).
- No release engineering (that is #330).
- No new locus abstraction — `locusCommand`/`toDistroPath`/`locusForRepo` are reused as-is.
- No sandbox, approval, or capability reduction anywhere (Rule Zero); the WSL codex runs the same full-access mode as host codex.

## Decisions

1. **Locus enters the codex seam as an optional param on the existing injection points** (`createCodexTurnTransport`, `createCodexExecutor`, and the desktop's codex harness composition), mirroring `ClaudeHarnessDeps.locus`. Spawns route `locusCommand(locus, bin, args, cwd)` → `execa(file, args)` exactly as `checkpoint-store.ts` does. Alternative (a global locus context) rejected: the per-call param is the established pattern and keeps the adapter package pure.
2. **Distro-side scratch for WSL turns.** For `locus.kind === "wsl"`, mint the scratch dir inside the distro (one `wsl.exe -d <distro> -e mktemp -d` per turn, same cost class as the turn itself) and hand codex distro-native `-o`/`--output-schema`/`-C` paths; the Windows side reads results back through the UNC view (`toWindowsView`). Alternative (host mkdtemp + UNC-to-distro translation) rejected: `toDistroPath` correctly refuses `C:\` paths — host scratch is structurally untranslatable, which is the bug being fixed.
3. **canvasOps reachability: probe, then bind accordingly; fail plainly.** Order: (a) if the distro shares localhost (WSL mirrored networking — detectable by probing the host listener from the distro), keep the shipped 127.0.0.1 URL; (b) otherwise bind the listener to the WSL-facing host address (the distro's default-route gateway, discovered from inside the distro) and hand that URL; (c) if neither probe succeeds, the codex turn settles failed naming the unreachable canvas surface. Never bind 0.0.0.0 (no reason to open the canvas surface beyond the distro route), never silently run host codex against a WSL repo. The probe is one short in-distro command per session establishment, cached per (distro, port) for the session.
4. **Read-pipeline threading: one-line adoption of `locusForRepo` at every site with a repo root in scope; `resolveKnowledgePort` gains a `repoRoot` parameter.** The resolver signature change (in `live-review-backend.ts`/`orchestrator.ts`) lets every backend resolve locus at call time instead of wiring time — the same fix shape the settings `detected` rung established. Alternative (lifting a review into the wiring closure) rejected: the parameter is smaller and matches how other per-review facts flow.
5. **Verification is a recorded matrix, not a new harness.** Lancelot runs: GUI dev-run; packaged win32 ZIP boot; full WSL review (dual-harness, write/push from the distro account); `;`-PATH `.cmd` shim resolution; WSL-remote editor open at a line. Evidence lands in the PR (non-secret), and the using-docs ceiling text is rewritten to the proven truth — including any part that fails, which stays documented as a ceiling rather than claimed.

## Risks / Trade-offs

- [Mirrored vs NAT networking varies per Windows config; the gateway probe can mispick] → the reachability probe is empirical (connect from the distro to the candidate URL) rather than config-sniffing; a failed probe is an honest failed turn, and live verification on lancelot (NAT default) exercises the real path.
- [`mktemp -d` per turn adds a wsl.exe round trip] → same order of cost as spawning codex itself; measured on lancelot before optimizing. No caching complexity until evidence demands it.
- [Ten one-line locus adoptions invite a missed site] → grep-proof in the change: an owned test (or lint-grade check) asserts no bare `getClaudeHarness()` call remains in MAIN, so a future host-default site reddens.
- [Distro codex absent while host codex present] → harness discovery already runs per locus; a WSL project without distro codex degrades to single-Claude exactly as today, disclosed by the existing health surface — not a new state.

## Open Questions

None blocking: the canvasOps route decision (mirrored vs gateway) is resolved empirically by the probe, and live verification answers the rest.
