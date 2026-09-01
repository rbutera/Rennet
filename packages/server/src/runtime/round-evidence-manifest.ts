import { parseUnifiedDiffFiles } from "@rennet/adapters";
import { buildHunkIndex } from "@rennet/core";
import {
  ROUND_EVIDENCE_MANIFEST_MAX_BYTES,
  ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES,
  type RoundEvidenceAnchor,
  type RoundEvidenceUnit,
  serializeRoundEvidenceManifest,
  sha256Hex,
  utf8ByteLength,
} from "@rennet/protocol";

/**
 * The round-report classifier's evidence manifest (#727 + #726, design D5).
 *
 * The classification turn used to receive `round.worker.diff` verbatim and uncapped,
 * and had to invent line numbers out of it. It now receives this manifest: canonically
 * ordered units with stable ids, measured against the limits declared in
 * `@rennet/protocol`'s `round-evidence` module. The classifier cites ids; the HOST
 * derives every line anchor from the diff it parsed itself.
 *
 * The verbatim diff still crosses only this one boundary — the manifest bounds what
 * crosses it and never leaks back into an ordinary lens prompt.
 */

/**
 * `ev-` + 16 hex of sha256 over the unit's identity. Content-derived, so REBUILDING
 * the same measured diff yields the same ids — that is the recovery path, and it is
 * the stability the system actually relies on — and a change in an UNRELATED FILE
 * never renumbers a surviving unit the way an ordinal would.
 *
 * The claim stops exactly there. A text hunk's identity includes its `@@` header, so
 * an unrelated edit ABOVE it in the SAME FILE shifts that header and re-keys the
 * hunk. Dropping the header from the identity would remove the shift and collide two
 * byte-identical hunks in one file onto one id, which is strictly worse: ids must be
 * UNIQUE within a manifest before being stable across manifests is worth anything.
 * Uniqueness is enforced, not assumed — see {@link duplicateEvidenceId}.
 */
function roundEvidenceId(kind: RoundEvidenceUnit["kind"], path: string, identity: string): string {
  return `ev-${sha256Hex(`${kind}\n${path}\n${identity}`).slice(0, 16)}`;
}

/**
 * The first id appearing twice, or `undefined`. A repeat means two units share an
 * identity string, or (astronomically) their sha256 prefixes collided in 16 hex.
 * Either way the partition's Sets would MERGE them silently — one placement would
 * satisfy both units and the report's attribution would stop being exhaustive — so
 * the manifest is rejected instead of quietly losing a unit.
 */
function duplicateEvidenceId(units: readonly RoundEvidenceUnit[]): string | undefined {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.id)) return unit.id;
    seen.add(unit.id);
  }
  return undefined;
}

/**
 * Code-unit string order, never `localeCompare`: the order is part of the contract,
 * and an ICU comparator makes it machine-dependent (under `sv_SE` `ä` sorts after
 * `z`). ONE comparator, shared by the manifest, the report builder, and the report
 * verifier — two "equivalent" comparators are exactly how those sides diverge on a
 * user's locale while every test on a `C`-locale machine stays green.
 */
export function compareByCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const KIND_ORDER: Record<RoundEvidenceUnit["kind"], number> = {
  rename: 0,
  "mode-change": 1,
  binary: 2,
  "text-hunk": 3,
};

function unitPosition(unit: RoundEvidenceUnit): number {
  return unit.kind === "text-hunk" ? unit.anchor.line : 0;
}

function compareUnits(left: RoundEvidenceUnit, right: RoundEvidenceUnit): number {
  const paths = compareByCodeUnit(left.path, right.path);
  if (paths !== 0) return paths;
  const kinds = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  if (kinds !== 0) return kinds;
  const position = unitPosition(left) - unitPosition(right);
  if (position !== 0) return position;
  return compareByCodeUnit(left.id, right.id);
}

/** The mode pair of a mode-only-or-mixed change, read from the patch preamble. A
 *  new or deleted file states one mode, not a change, so both lines are required. */
function modeChange(patch: string): { from: string; to: string } | undefined {
  const from = /^old mode (\d+)$/m.exec(patch)?.[1];
  const to = /^new mode (\d+)$/m.exec(patch)?.[1];
  return from === undefined || to === undefined || from === to ? undefined : { from, to };
}

/**
 * The hunk's first ADDED line — what the coding turn left behind, which is what a
 * reader following the anchor wants to land on — or its first deleted line when the
 * hunk only removes. Context lines are not evidence, so a hunk with neither yields no
 * anchor and no unit: it states nothing to classify.
 */
function hunkAnchor(
  body: readonly string[],
  spans: { old: { start: number }; new: { start: number } },
  headPath: string,
  basePath: string,
): RoundEvidenceAnchor | undefined {
  let oldLine = spans.old.start;
  let newLine = spans.new.start;
  let deletion: RoundEvidenceAnchor | undefined;
  for (const line of body) {
    if (line.startsWith("+")) return { side: "head", path: headPath, line: newLine };
    if (line.startsWith("-")) {
      deletion ??= { side: "base", path: basePath, line: oldLine };
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return deletion;
}

/**
 * Build the canonically ordered manifest for one coding turn's measured diff.
 *
 * Mixed changes stay lossless: a renamed file that also changed text contributes a
 * `rename` unit AND its `text-hunk` units; a mode change beside real edits contributes
 * both. No variant fabricates a line anchor for a change that has none.
 */
export function buildRoundEvidenceManifest(diff: string): RoundEvidenceUnit[] {
  const files = parseUnifiedDiffFiles(diff, Number.POSITIVE_INFINITY);
  const units: RoundEvidenceUnit[] = [];
  for (const file of files) {
    const basePath = file.previousPath ?? file.path;
    if (file.previousPath !== undefined) {
      units.push({
        kind: "rename",
        id: roundEvidenceId("rename", file.path, file.previousPath),
        path: file.path,
        previousPath: file.previousPath,
      });
    }
    const mode = modeChange(file.patch);
    if (mode !== undefined) {
      units.push({
        kind: "mode-change",
        id: roundEvidenceId("mode-change", file.path, `${mode.from}>${mode.to}`),
        path: file.path,
        from: mode.from,
        to: mode.to,
      });
    }
    if (file.binary) {
      units.push({
        kind: "binary",
        id: roundEvidenceId("binary", file.path, file.status),
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
      });
      continue;
    }
    for (const hunk of buildHunkIndex({ files: [file] }).hunks) {
      const anchor = hunkAnchor(hunk.body, hunk.spans, file.path, basePath);
      if (anchor === undefined) continue;
      const text = [hunk.header, ...hunk.body].join("\n");
      units.push({
        kind: "text-hunk",
        id: roundEvidenceId("text-hunk", file.path, text),
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        text,
        anchor,
      });
    }
  }
  return units.sort(compareUnits);
}

export type RoundEvidenceManifestMeasurement =
  | { readonly ok: true; readonly json: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Measure the COMPLETE serialized manifest against the declared limits. Over either
 * limit is a typed local failure the caller returns BEFORE any provider call — never
 * a truncation, a split, or a summary, because a manifest that fits by omission is a
 * classification of a change that did not happen.
 */
export function measureRoundEvidenceManifest(
  units: readonly RoundEvidenceUnit[],
): RoundEvidenceManifestMeasurement {
  const duplicate = duplicateEvidenceId(units);
  if (duplicate !== undefined) {
    return {
      ok: false,
      reason: `the round evidence manifest repeats evidence id ${duplicate}, so two units cannot be addressed separately`,
    };
  }
  if (units.length > ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `the round evidence manifest holds ${units.length} entries, over the ${ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES}-entry limit`,
    };
  }
  const json = serializeRoundEvidenceManifest(units);
  const bytes = utf8ByteLength(json);
  if (bytes > ROUND_EVIDENCE_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      reason: `the round evidence manifest measures ${bytes} UTF-8 bytes, over the ${ROUND_EVIDENCE_MANIFEST_MAX_BYTES}-byte limit`,
    };
  }
  return { ok: true, json, bytes };
}

/** One bucket of the classification: an ask outcome or a `beyond asks` entry. */
export interface RoundEvidenceCitation {
  readonly bucket: string;
  readonly evidenceIds: readonly string[];
}

/**
 * The exactly-once partition (#726): every manifest id appears in exactly one ask
 * bucket or the `beyond asks` bucket. Unknown, duplicated, and omitted ids are all
 * rejected — before persistence — so the report's attribution is exhaustive and
 * non-overlapping rather than "whatever the model chose to mention".
 */
export function verifyRoundEvidencePartition(
  citations: readonly RoundEvidenceCitation[],
  manifest: readonly RoundEvidenceUnit[],
): void {
  // The Sets below address units BY ID. A repeated id would let one placement satisfy
  // two units, so the partition would report itself exhaustive while a unit went
  // unclassified — reject before that can happen, on the recovery path too.
  const duplicate = duplicateEvidenceId(manifest);
  if (duplicate !== undefined) {
    throw new Error(`repeats evidence id ${duplicate}, which cannot be placed separately`);
  }
  const known = new Set(manifest.map((unit) => unit.id));
  const placed = new Set<string>();
  for (const citation of citations) {
    for (const id of citation.evidenceIds) {
      if (!known.has(id)) {
        throw new Error(`cites unknown evidence id ${id} in ${citation.bucket}`);
      }
      if (placed.has(id)) {
        throw new Error(`places evidence id ${id} in more than one bucket`);
      }
      placed.add(id);
    }
  }
  const missing = manifest.filter((unit) => !placed.has(unit.id)).map((unit) => unit.id);
  if (missing.length > 0) {
    throw new Error(`leaves evidence unplaced: ${missing.join(", ")}`);
  }
}
