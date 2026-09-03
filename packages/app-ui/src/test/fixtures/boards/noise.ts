import type { LensBoard } from "@rennet/protocol";
import { board, codeRef, noiseVerdict, prose, section } from "./helpers";

const CHANGE = "openspec/changes/github-token-refresh-reliability";

// Noise lens — hunks set aside as noise, judged per-hunk, nothing dropped. The
// spike's `noise-group` composite is expressed as per-hunk `noise_verdict` elements.
export const noiseBoard: LensBoard = board("noise", "gen1", "noise-gen1", [
  section(
    "mechanical",
    "Mechanical & Generated Churn",
    "A barrel and an import that echo the two new symbols, plus the generated scaffold stamp.",
    [
      prose(
        "noise-intro",
        "This change is almost all behavior and its specification. What is left over: an export list grows to carry the two new symbols, an import list grows the same way, and a two-line scaffold stamp written when the change directory was created.",
      ),
      noiseVerdict("nv-barrel", {
        hunk: "cr-barrel",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "Adds `RefreshLogRecord` and `tokenKind` to the adapters barrel export — each name joins a specifier list that already carries its siblings. No statement changed.",
      }),
      noiseVerdict("nv-import", {
        hunk: "cr-import",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "Widens the single-symbol test import to a named block pulling in `RefreshLogRecord` and `tokenKind`. The import list grew to match the new source.",
      }),
      noiseVerdict("nv-scaffold", {
        hunk: "cr-scaffold",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "The openspec tool writes this two-line file when it creates a change directory: a schema tag and a creation date. No requirement text, no behavior.",
      }),
    ],
    {
      refs: [
        codeRef("cr-barrel", "packages/adapters/src/index.ts", 1, 4),
        codeRef("cr-import", "packages/adapters/src/github-auth.test.ts", 1, 6),
        codeRef("cr-scaffold", `${CHANGE}/.openspec.yaml`, 1, 2),
      ],
    },
  ),
]);
