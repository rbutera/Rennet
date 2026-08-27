import type { DossierItem, KnowledgeSet, Patchset, SuccessorAccount } from "@rennet/protocol";
import { parseFilePatch } from "../decomposition";
import { type BlastRadiusSignalMark, computeBlastRadius } from "./blast-radius";
import { buildCounterpartHints, type CounterpartHint } from "./counterpart-hints";
import { buildHunkIndex, type HunkIndex } from "./hunk-index";
import { type NoisePreclassFact, preclassifyNoise } from "./noise-preclass";

/**
 * One changed file of the packet's patchset meta — the file row without its
 * patch text, plus typed mode-change evidence where the diff carries one (a
 * chmod-only file has zero hunks; without this it would vanish from the
 * drafters' input entirely).
 */
export type DeltaPacketFile = Omit<Patchset["files"][number], "patch"> & {
  readonly modeChange?: { readonly old: string; readonly new: string };
};

/** The openspec artifacts the patchset touches, at path grain (see `buildDeltaPacket`). */
export interface OpenSpecTouch {
  /** One entry per touched `openspec/changes/<name>/` directory, sorted by name. */
  readonly changes: readonly {
    readonly name: string;
    readonly artifactPaths: readonly string[];
  }[];
}

/**
 * The lens drafters' entire input (#464: inlined into drafting prompts, not
 * tool-fetched), assembled from an immutable patchset and the supplied protocol
 * contracts. Every derived fact is typed data, never hand-retyped (#464 dec. 2).
 */
export interface DeltaPacket {
  /** Patchset identity + file inventory — the meta, not the raw patches (those live in `hunks`). */
  readonly patchset: {
    readonly id: Patchset["id"];
    readonly createdAt: Patchset["createdAt"];
    readonly truncated: Patchset["truncated"];
    readonly files: readonly DeltaPacketFile[];
  };
  readonly hunks: HunkIndex;
  readonly knowledge: KnowledgeSet;
  readonly dossier: readonly DossierItem[];
  /** Present iff a prior generation exists (the caller supplies it on rounds). */
  readonly successorAccount?: SuccessorAccount;
  readonly blastRadius: readonly BlastRadiusSignalMark[];
  /** Present iff the patchset touches openspec artifacts. */
  readonly openspec?: OpenSpecTouch;
  readonly noisePreclass: readonly NoisePreclassFact[];
  readonly counterpartHints: readonly CounterpartHint[];
}

const OPENSPEC_CHANGE_PATH = /^openspec\/changes\/([^/]+)\//;

/** Path-grain openspec facts: which change dirs the patchset touches, or undefined. */
function openspecTouch(files: Patchset["files"]): OpenSpecTouch | undefined {
  const byChange = new Map<string, string[]>();
  for (const file of files) {
    const name = file.path.match(OPENSPEC_CHANGE_PATH)?.[1];
    if (name === undefined) continue;
    const paths = byChange.get(name) ?? [];
    paths.push(file.path);
    byChange.set(name, paths);
  }
  if (byChange.size === 0) return undefined;
  return {
    changes: [...byChange.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, artifactPaths]) => ({ name, artifactPaths: [...artifactPaths].sort() })),
  };
}

/**
 * Assemble the Delta packet — pure, deterministic, no I/O, no model call. The
 * patchset supplies every derived section (hunk index, blast radius, noise
 * pre-classification, counterpart hints, openspec touch); knowledge, dossier and
 * the successor account arrive as the protocol contracts their producers minted
 * (B6/B7/rounds) and are carried through, never re-modeled.
 *
 * Blast radius here is patchset-only: ownership rules and the fan-in index live
 * with the project snapshot (I/O), so those signals stay honestly not-assessed /
 * absent until B8's dispatch — which owns the snapshot — feeds them in. The
 * openspec section is path grain for the same reason: artifact TEXT is read off
 * disk, so the full `parseOpenSpecChange` runs where the text lives (B8), over
 * the same seam-exported parser.
 */
export function buildDeltaPacket(
  patchset: Patchset,
  knowledge: KnowledgeSet,
  dossier: readonly DossierItem[],
  successorAccount?: SuccessorAccount,
): DeltaPacket {
  const hunks = buildHunkIndex(patchset);
  const openspec = openspecTouch(patchset.files);
  return {
    patchset: {
      id: patchset.id,
      createdAt: patchset.createdAt,
      truncated: patchset.truncated,
      files: patchset.files.map((file) => {
        const modeChange =
          file.binary || file.patch === "" ? undefined : parseFilePatch(file.patch).modeChange;
        return {
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary,
          ...(modeChange !== undefined ? { modeChange } : {}),
        };
      }),
    },
    hunks,
    knowledge,
    dossier,
    ...(successorAccount !== undefined ? { successorAccount } : {}),
    blastRadius: computeBlastRadius({ files: patchset.files, ownership: [] }),
    ...(openspec !== undefined ? { openspec } : {}),
    noisePreclass: preclassifyNoise(hunks),
    counterpartHints: buildCounterpartHints(patchset.files.map((file) => file.path)),
  };
}
