# OpenSpec changes — status

**Read this before picking up a change directory.** Checkbox state in `tasks.md` is badly stale corpus-wide: several changes show 0 of N tasks ticked while their code is fully shipped on `main`. Do not infer "open" from unticked boxes. Verified 2026-08-11 by artifact existence.

Rule Zero (`AGENTS.md`) outranks every spec in here. Several carry ⛔ supersession banners; the struck requirements are not work.

## Genuinely open

- **`build-repo-map-lifecycle`** — the only live one. Wave 1 landed (`knowledge.ts`, `escape-path.ts`); the delta-pass half has not. Tracked as #243.

## Shipped — archive candidates

All of the following have their code on `main`. Treat as done.

`build-canvas-state-model`, `build-codex-utility-port`, `build-comprehension-ordering-pass`, `build-decomposition-angle-generation`, `build-decomposition-floor`, `build-github-changeset-source`, `build-harness-adapter-protocol`, `build-local-review-mvp`, `build-model-council-v1`, `build-orchestrator-session`, `build-publish-safety-gate`, `build-rsp-document-core`, `build-wire-claude-sdk`, `harden-nx-cache-hygiene`, `wire-live-review-pipeline`, `wire-model-council-live`.

Shipped **despite unticked boxes** — these look open and are not:

| change | shipped artifact |
|---|---|
| `add-review-intelligence-core` (0/40) | `core/hypothesis-generation.ts`, `dual-seat.ts`, `finding-reconcile.ts`, `finding-verification.ts` |
| `build-canvas-ui` | `ui/canvas/logic.ts` |
| `build-canvasops-mcp-surface` | `core/canvas-ops.ts`, `adapters/canvas-ops-server.ts` |
| `build-destination-frame` | `ui/canvas/destination.ts`, `ui/canvas/publish.ts` |
| `build-disposition-ui` | `ui/canvas/authoring.ts` |
| `build-inhabited-codeview` | `ui/components/code-view.tsx` |
| `build-span-grained-dispositions` | `core/dispositions-span.test.ts` |
| `deliver-real-diff-on-zoom` | `core/element-diffs.ts` |
| `wire-live-end-to-end-review` | `core/project-snapshot.ts` |

## Two specs that describe gates, not product

- **`build-publish-safety-gate`** — roughly half is retired under Rule Zero: the acknowledge-control that blocks signing until run degradations are confirmed, and the framing that #21 may not land until this is green. The surviving half is good and worth keeping: emit-fidelity tests (published bytes byte-equal previewed bytes), hold-gate wiring tests, and the keyboard-accessibility fix, which unblocks a user who currently cannot publish by keyboard at all.
- **`build-harness-adapter-protocol`** — the read-only harness posture is superseded. It is still live in code; tracked as **#259**.
