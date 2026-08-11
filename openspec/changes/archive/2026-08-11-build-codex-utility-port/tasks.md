## 1. The port (core: codex-utility-port.ts)

- [x] 1.1 The executor seam types: `CodexExecRequest`, `CodexExecResult`, `CodexExecutor`
- [x] 1.2 The request/result types: `CodexUtilityCompleteRequest`, `CodexUtilityAttempt`, `CodexUtilityResult` (discriminated: admitted | rejected | exec-failed), `CodexUtilityPort`, `CodexUtilitySeed`
- [x] 1.3 Defaults: `DEFAULT_CODEX_UTILITY_MODEL` (gpt-5.6-luna), `DEFAULT_CODEX_UTILITY_EFFORT` (low), `CODEX_ADAPTER_VERSION`; the capability snapshot (structuredOutput + perCallModelSelection, three layers each)
- [x] 1.4 `createCodexUtilityPort({ executor, seed?, mintDocId?, newRunId? })`: derive `bodyJsonSchema(docType)`, compute `inputDigest`, loop ≤maxRetries — assemble prompt (system + user + fed-back report), run executor, stamp envelope (tier light / route utility / modelReportedBy config), `validateDocument`, admit or feed the report back
- [x] 1.5 Fail-closed terminal: `status: "admitted"` only inside `report.admitted`; else last rejection → `rejected`; else `exec-failed`. Re-export from `packages/core/src/index.ts`

## 2. The real executor (adapters: codex-exec.ts)

- [x] 2.1 `buildCodexExecArgs(req, { schemaPath?, outPath })` — pure argv assembly with all four gotchas (`--ignore-user-config`, `--skip-git-repo-check`, `-o`, plus `-m`/`-c model_reasoning_effort=`/`--output-schema`/positional prompt)
- [x] 2.2 `createCodexExecutor(effects?, opts?)` — write schema temp, spawn via injected `run` (execa `stdin: "ignore"`), read `-o` output, JSON.parse, clean up temp dir; non-zero exit / bad JSON → throw
- [x] 2.3 `createCodexUtilityAdapter(deps?)` — composition root wiring the real executor into `createCodexUtilityPort`; re-export from `packages/adapters/src/index.ts`

## 3. Tests + gates

- [x] 3.1 core: faked executor → validator-ADMITTED `ordering` doc; provenance asserts tier light / route utility / model / inputDigest == computeInputDigest / capability both three-layer / modelReportedBy config / usd null; the executor received the derived `outputSchema`
- [x] 3.2 core: schema-invalid body on attempt 0 then valid → admitted with attempts [rejected, admitted]; always-invalid → `status: "rejected"` after 3 attempts (never admits blind); executor throws → `exec-failed`
- [x] 3.3 adapters: `buildCodexExecArgs` asserts all four gotcha flags present in argv (no spawn); `createCodexExecutor` with a fake `run`/fs writes the schema, passes the argv, reads+parses the `-o` output, and surfaces a non-zero exit as a throw
- [x] 3.4 adapters: GATED real-turn (`it.skipIf(!RENNET_LIVE_CODEX)`) — one real `gpt-5.6-luna` `codex exec` → validator-admitted `ordering`; skipped in the normal gate, no metered spend
- [x] 3.5 Gate green: `tsc6 -p` typecheck (core + adapters), vitest (core + adapters src), and `pnpm check` (format/architecture/licenses/lint/typecheck/test/build)
