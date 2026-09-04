import type { DossierItem, Patchset, SuccessorAccount } from "@rennet/protocol";
import { parseFilePatch } from "../decomposition";
import {
  type BlastRadiusSignalMark,
  compareStrings,
  computeBlastRadius,
  type FanInIndex,
} from "./blast-radius";
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
 * The change's derived INVENTORY, assembled from an immutable patchset and the
 * supplied protocol contracts. Every derived fact is typed data, never
 * hand-retyped (#464 dec. 2). Since the context-map kill this is no longer the
 * drafters' entire input: the prompt carries this inventory with the hunk
 * BODIES redacted, and the drafter reads content from the reviewed checkout.
 */
export interface DeltaPacket {
  /** Patchset identity + file inventory — the meta, not the raw patches (those live in `hunks`). */
  readonly patchset: {
    readonly id: Patchset["id"];
    readonly createdAt: Patchset["createdAt"];
    readonly truncated: Patchset["truncated"];
    /**
     * The reviewed range's identity, for a drafter that reads the checkout
     * itself: the commits since `baseOid`, at `headOid`. Never host paths.
     */
    readonly repository: {
      readonly baseRef: Patchset["repository"]["baseRef"];
      readonly baseOid: Patchset["repository"]["baseOid"];
      readonly headOid: Patchset["repository"]["headOid"];
      /**
       * Present on a local working-tree capture: the durable tree object the
       * reviewed bytes were pinned as. When set, the reviewed delta is
       * `git diff <baseOid> <reviewedTreeOid>` — `baseOid..headOid` would show
       * only the committed subset and silently omit uncommitted work.
       */
      readonly reviewedTreeOid?: Patchset["repository"]["reviewedTreeOid"];
    };
    readonly files: readonly DeltaPacketFile[];
  };
  readonly hunks: HunkIndex;
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

/**
 * Path-grain openspec facts: which change dirs the patchset touches, or
 * undefined. A rename's OLD side (`previousPath`) counts as touched too —
 * a rename out of a change dir still changes that change.
 */
function openspecTouch(files: Patchset["files"]): OpenSpecTouch | undefined {
  const byChange = new Map<string, string[]>();
  for (const file of files) {
    for (const path of [file.path, file.previousPath]) {
      if (path === undefined) continue;
      const name = path.match(OPENSPEC_CHANGE_PATH)?.[1];
      if (name === undefined) continue;
      const paths = byChange.get(name) ?? [];
      if (!paths.includes(path)) paths.push(path);
      byChange.set(name, paths);
    }
  }
  if (byChange.size === 0) return undefined;
  return {
    changes: [...byChange.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([name, artifactPaths]) => ({
        name,
        artifactPaths: [...artifactPaths].sort(compareStrings),
      })),
  };
}

/**
 * The one `git diff` a seat runs to read the reviewed change from the checkout it is
 * standing in. Two capture shapes, two commands, and neither lets the prompt claim the
 * working directory IS the reviewed state, because it may not be:
 *  - a working-tree capture pins the reviewed bytes as `reviewedTreeOid` (`base..head`
 *    would omit uncommitted work), and the live tree can move after capture;
 *  - a range capture (PR / branch) diffs `base...head` (THREE-dot: from the merge base —
 *    an advanced base with two dots invents base-only deletions), and the checkout may
 *    sit on a different ref entirely.
 * Pinned objects are always readable: `git show <oid>:<path>`.
 */
export function reviewedDiffCommand(
  repository: Pick<Patchset["repository"], "baseOid" | "headOid" | "reviewedTreeOid">,
): string {
  return repository.reviewedTreeOid === undefined
    ? `git diff ${repository.baseOid}...${repository.headOid}`
    : `git diff ${repository.baseOid} ${repository.reviewedTreeOid}`;
}

/**
 * Assemble the Delta packet — pure, deterministic, no I/O, no model call. The
 * patchset supplies every derived section (hunk index, blast radius, noise
 * pre-classification, counterpart hints, openspec touch); the dossier and the
 * successor account arrive as the contracts their producers minted (B6/B7/rounds)
 * and are carried through VERBATIM, never re-modeled here.
 *
 * Blast radius reads the snapshot-derived `fanIn` index when the composition root
 * supplies one (it supplies it only when the snapshot can genuinely answer "what
 * depends on this file?"); without it the fan-in signal stays honestly NOT
 * ASSESSED rather than a silent zero. Ownership rules are still patchset-only. The
 * openspec section is path grain because artifact TEXT is read off disk, so the
 * full `parseOpenSpecChange` runs where the text lives (B8), over the same
 * seam-exported parser.
 */
export function buildDeltaPacket(
  patchset: Patchset,
  dossier: readonly DossierItem[],
  successorAccount?: SuccessorAccount,
  fanIn?: FanInIndex,
): DeltaPacket {
  const hunks = buildHunkIndex(patchset);
  const openspec = openspecTouch(patchset.files);
  return {
    patchset: {
      id: patchset.id,
      createdAt: patchset.createdAt,
      truncated: patchset.truncated,
      repository: {
        baseRef: patchset.repository.baseRef,
        baseOid: patchset.repository.baseOid,
        headOid: patchset.repository.headOid,
        ...(patchset.repository.reviewedTreeOid === undefined
          ? {}
          : { reviewedTreeOid: patchset.repository.reviewedTreeOid }),
      },
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
    dossier,
    ...(successorAccount !== undefined ? { successorAccount } : {}),
    blastRadius: computeBlastRadius({
      files: patchset.files,
      ownership: [],
      ...(fanIn === undefined ? {} : { fanIn }),
    }),
    ...(openspec !== undefined ? { openspec } : {}),
    noisePreclass: preclassifyNoise(hunks),
    counterpartHints: buildCounterpartHints(patchset.files.map((file) => file.path)),
  };
}
