import {
  bmadSpecSourceToDesignSources,
  type CandidateDesignSource,
  grillSpecSourceToDesignSources,
  kiroSpecSourceToDesignSources,
  openSpecChangeSourceToDesignSources,
  superpowersSpecSourceToDesignSources,
} from "@rennet/core";
import type { Patchset } from "@rennet/protocol";
import { readBmadSpecSource } from "./bmad-spec-reader";
import type { GitExec } from "./git-range-diff";
import { readGrillSpecSource } from "./grill-spec-reader";
import { readKiroSpecSource } from "./kiro-spec-reader";
import { readOpenSpecChangeSource } from "./openspec-change-reader";
import { readSuperpowersSpecSource } from "./superpowers-spec-reader";

// ─────────────────────────────────────────────────────────────────────────────
// The Design assembler's one read: whichever specification format the reviewed
// patchset touches, as the design sources `assembleDesignBoard` consumes.
//
// The Design lens drafts ONE specification, never a merge of several. When a patchset
// touches more than one format (a repository mid-migration, or a change that edits an
// ADR beside its OpenSpec change), the first in this order wins: OpenSpec, Kiro, BMAD,
// Superpowers, grill-with-docs. The order runs from the format whose files are the most
// complete statement of a change to the sparsest — an ADR beside an OpenSpec change is
// context for it, not a rival specification — and it is fixed so the same patchset
// always assembles the same board.
//
// Every reader is path-selected first and reads only at the immutable reviewed tree, so
// a patchset touching no specification costs at most one `git show` (BMAD's
// `core-config.yaml`, which decides where its documents live) before `null` comes back.
// ─────────────────────────────────────────────────────────────────────────────

type SourceRead = (patchset: Patchset, git: GitExec) => Promise<CandidateDesignSource[] | null>;

const READERS: readonly SourceRead[] = [
  async (patchset, git) => {
    const source = await readOpenSpecChangeSource(patchset, git);
    return source === null ? null : openSpecChangeSourceToDesignSources(source);
  },
  async (patchset, git) => {
    const source = await readKiroSpecSource(patchset, git);
    return source === null ? null : kiroSpecSourceToDesignSources(source);
  },
  async (patchset, git) => {
    const source = await readBmadSpecSource(patchset, git);
    return source === null ? null : bmadSpecSourceToDesignSources(source);
  },
  async (patchset, git) => {
    const source = await readSuperpowersSpecSource(patchset, git);
    return source === null ? null : superpowersSpecSourceToDesignSources(source);
  },
  async (patchset, git) => {
    const source = await readGrillSpecSource(patchset, git);
    return source === null ? null : grillSpecSourceToDesignSources(source);
  },
];

/**
 * The design sources of the first specification format the reviewed patchset touches,
 * read at the reviewed tree, or `null` when it touches none — the honest "no
 * specification in this review" case, which sends the Design lens to its model seat to
 * look for itself.
 */
export async function readDesignSources(
  patchset: Patchset,
  git: GitExec,
): Promise<CandidateDesignSource[] | null> {
  for (const read of READERS) {
    const sources = await read(patchset, git);
    if (sources !== null && sources.length > 0) return sources;
  }
  return null;
}
