/**
 * `design-sources.md` — the specification the HOST located for this branch, as a context
 * file the Design seat is pointed at.
 *
 * The Design readers select a specification from the packet's paths and read its files at
 * the reviewed tree before any lane opens; when the format is one the assembler renders,
 * the board is built on the host and no seat runs. When the assembler declines — an
 * OpenSpec `RENAMED` block, a proposal with no obligation to render, a lint refusal — the
 * seat used to start from nothing and go looking for a specification the host had already
 * found, spending its opening turns on `git log` and a directory walk to arrive at the paths
 * in this file. So the paths travel: format, and one line per artifact. Never the text —
 * the seat reads each file with its own tools from the checkout it is standing in, which is
 * the progressive-disclosure rule every other context file follows.
 */

import type { SessionContextFile } from "../session-context";
import type { CandidateDesignSource, DesignSourceFormat } from "./design-obligations";

export const DESIGN_SOURCES_FILE = "design-sources.md";

/** The most artifact lines the file lists; past it the file says how many it dropped. */
export const DESIGN_SOURCES_MAX_PATHS = 40;

export type LocatedDesignSource = Pick<CandidateDesignSource, "format" | "role" | "path">;

const FORMAT_LABEL: Readonly<Record<DesignSourceFormat, string>> = {
  openspec: "OpenSpec",
  kiro: "Kiro",
  bmad: "BMAD",
  superpowers: "Superpowers",
  "grill-with-docs": "grill-with-docs",
};

/**
 * Build the file, or `undefined` when the host located nothing — a prompt must never name
 * a file that was not written.
 */
export function designSourcesContextFile(
  sources: readonly LocatedDesignSource[],
  maxPaths: number = DESIGN_SOURCES_MAX_PATHS,
): SessionContextFile | undefined {
  const first = sources[0];
  if (first === undefined) return undefined;
  const shown = sources.slice(0, maxPaths);
  const dropped = sources.length - shown.length;
  const lines = [
    "# The specification the host located for this branch",
    "",
    `Format: ${first.format === undefined ? "unknown" : FORMAT_LABEL[first.format]}. These files ARE this branch's specification, selected from the reviewed change's own paths and present at the reviewed tree. Render them; do not search for another and do not settle absent. Read each with your own tools.`,
    "",
    ...shown.map((source) => `- \`${source.path}\` — ${source.role}`),
    ...(dropped > 0
      ? [`- … and ${dropped} more artifact${dropped === 1 ? "" : "s"} not listed`]
      : []),
    "",
  ];
  return {
    name: DESIGN_SOURCES_FILE,
    body: lines.join("\n"),
    holds:
      "The specification the host located for this branch: its format and every artifact path, at the reviewed tree.",
    readWhen:
      "first — the specification is these files, so render them rather than searching for one.",
  };
}
