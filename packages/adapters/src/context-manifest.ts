import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleContext, type ContextAssembly, type ContextDocumentInput } from "@rennet/core";
import type { RepoComposition } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The ADAPTER side of the ContextManifest assembly (issue #30). `core`'s
// `assembleContext` is a pure, deterministic, byte-budgeted function over an
// ORDERED list of candidate documents; this module gathers those documents from
// the live repo (repo guidance + a deterministic project-map projection) and hands
// them to the assembly.
//
// Repo guidance (CLAUDE.md, AGENTS.md, `.rennet/`) feeds the assembly DIRECTLY,
// labelled by source — no accept/trust step, no inert-until-accepted gate (Rule
// Zero). A missing guidance file is simply absent from the assembly; honesty about
// what was sent is the manifest's job, not a ceremony.
// ─────────────────────────────────────────────────────────────────────────────

/** The default per-assembly byte budget (32 KiB). Metered + visible, never a silent drop. */
export const DEFAULT_CONTEXT_BYTE_BUDGET = 32_768;

/** The repo-guidance files gathered into fleet context, in deterministic order, labelled by source. */
const GUIDANCE_FILES: readonly { readonly source: string; readonly path: string }[] = [
  { source: "claude-md", path: "CLAUDE.md" },
  { source: "agents-md", path: "AGENTS.md" },
];

/** Render a deterministic project-map document from a composition (stable ordering). */
function renderProjectMapDocument(composition: RepoComposition): string {
  const members = [...composition.submodules]
    .map((member) => `- ${member.path} (${member.status})`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    `project ${composition.repoRecordId}`,
    `snapshot ${composition.projectSnapshotId}`,
    `freshness ${composition.freshness.status}`,
    members.length > 0 ? `members:\n${members.join("\n")}` : "members: (none)",
  ].join("\n");
}

/**
 * Gather the ordered candidate documents for a fleet dispatch: the repo guidance
 * files that exist (labelled by source), then a deterministic project-map
 * projection of the composition. The order is fixed (guidance first, then the map)
 * so the assembly is deterministic. A guidance file that cannot be read is skipped
 * (absent, not fatal) — never a throw.
 */
export function gatherContextDocuments(
  repoRoot: string,
  composition: RepoComposition,
): ContextDocumentInput[] {
  const documents: ContextDocumentInput[] = [];
  for (const guidance of GUIDANCE_FILES) {
    const absolute = join(repoRoot, guidance.path);
    if (!existsSync(absolute)) continue;
    try {
      documents.push({
        source: guidance.source,
        sourcePath: guidance.path,
        content: readFileSync(absolute, "utf8"),
      });
    } catch {
      // Unreadable guidance is simply absent from the assembly (honest omission).
    }
  }
  documents.push({
    source: "project-map",
    sourcePath: "(project-map)",
    content: renderProjectMapDocument(composition),
  });
  return documents;
}

/**
 * Assemble the deterministic, byte-budgeted context for a composition rooted at
 * `repoRoot`. Pure over the gathered documents (`core`'s `assembleContext`), so the
 * result is byte-identical for identical inputs.
 */
export function assembleContextForComposition(
  repoRoot: string,
  composition: RepoComposition,
  byteBudget: number = DEFAULT_CONTEXT_BYTE_BUDGET,
): ContextAssembly {
  return assembleContext(gatherContextDocuments(repoRoot, composition), byteBudget);
}
